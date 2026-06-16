import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { runTurn } from "../src/ai/run.js";
import { createConversationSummarizer } from "../src/ai/inference.js";
import { embed } from "../src/ai/provider.js";
import { Localizer } from "../src/bot/i18n.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import type { ThreadRow, UserRow } from "../src/db/types.js";
import { ingestFileBytes } from "../src/files/ingest.js";
import { createLogger } from "../src/logger.js";
import { compactThread } from "../src/memory/compactor.js";
import { buildContext } from "../src/memory/contextBuilder.js";

const kotlinPdfPath = process.argv[2] ?? "/Users/karilaa/Downloads/How to Build Android Applications with Kotlin.pdf";
const dbPath = path.resolve("data", `live-compacted-book-${Date.now()}.sqlite`);

const config = loadConfig({
  ...process.env,
  BOT_TOKEN: process.env.BOT_TOKEN || "TEST:TOKEN",
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || "1000",
  DB_URL: `sqlite:${dbPath}`,
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
});
const logger = createLogger(config);
const db = createDatabase(config, logger);
const localizer = new Localizer();
const checks: Array<{ name: string; ok: boolean; details?: unknown }> = [];

function check(name: string, ok: boolean, details?: unknown): void {
  checks.push({ name, ok, details });
  console.log(JSON.stringify({ check: name, ok, details }));
  if (!ok) throw new Error(`Compacted book retrieval check failed: ${name}`);
}

class CaptureApi {
  private messageId = 20_000;
  readonly richMessages: unknown[] = [];
  readonly drafts: unknown[] = [];
  readonly plainMessages: unknown[] = [];

  readonly raw = {
    sendRichMessage: async (payload: unknown) => {
      this.richMessages.push(payload);
      return this.sentMessage();
    },
    sendRichMessageDraft: async (payload: unknown) => {
      this.drafts.push(payload);
      return true;
    },
  };

  async sendMessage(chatId: number, text: string, other?: unknown) {
    this.plainMessages.push({ chatId, text, other });
    return this.sentMessage(chatId, text);
  }

  async sendChatAction() {
    return true;
  }

  private sentMessage(chatId = 646464, text?: string) {
    return {
      message_id: this.messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "BookQA" },
      text,
    };
  }
}

type Variation = {
  name: string;
  prompt: string;
  expected: RegExp;
  requireReadSection?: boolean;
  requireSearchThread?: boolean;
};

const variations: Variation[] = [
  {
    name: "gradle-plugin-aliases",
    prompt:
      "Earlier I uploaded a large Android/Kotlin book PDF, but that upload is now in compacted history. Without guessing, answer: where does the book show the Gradle Kotlin plugin aliases, and what are the relevant alias names?",
    expected: /kotlin|compose|plugin|alias/i,
  },
  {
    name: "lifecycle-runtime-setup",
    prompt:
      "I do not know the file number anymore. In the big Android book from earlier, inspect the section around lifecycleRuntimeKtx in the first app setup and summarize what versions or dependencies are nearby.",
    expected: /lifecycleRuntimeKtx|lifecycle|junit|espresso|version/i,
    requireReadSection: true,
  },
  {
    name: "recover-book-from-history",
    prompt:
      "Using the compacted thread history, recover the uploaded Kotlin Android book and explain what it says about creating your first app. Include the page or section you used.",
    expected: /first app|creating your first app|Android|Kotlin/i,
    requireReadSection: true,
  },
  {
    name: "kotlin-compose-surrounding-block",
    prompt:
      "From the earlier uploaded book, find the surrounding configuration block for `kotlin-compose` and tell me what plugin line appears there.",
    expected: /kotlin-compose|org\.jetbrains\.kotlin\.plugin\.compose|plugin/i,
    requireReadSection: true,
  },
];

try {
  await db.migrate();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 646464, firstName: "BookQA", lang: "en" });
  const parent = await setupCompactedParent(repos, user);
  const parentLatest = await repos.messages.latest(parent.id);
  if (!parentLatest) throw new Error("parent thread has no latest message");

  for (const [index, variation] of variations.entries()) {
    const thread = await repos.threads.create({
      userId: user.tg_id,
      topicId: 7_000 + index,
      title: `Book QA ${variation.name}`,
      parentThreadId: parent.id,
      forkPointMessageId: parentLatest.id,
    });
    await runVariation({ repos, user, thread, variation });
  }

  console.log(JSON.stringify({ ok: true, checks: checks.length, dbPath }));
} finally {
  await db.destroy().catch(() => undefined);
}

async function setupCompactedParent(repos: Repos, user: UserRow): Promise<ThreadRow> {
  const thread = await repos.threads.activeForUserTopic(user.tg_id, null, "Compacted book parent");
  const pdfBytes = await fs.readFile(kotlinPdfPath);
  const pdf = await ingestFileBytes({
    config,
    repo: repos.files,
    userId: user.tg_id,
    threadId: thread.id,
    telegramFileId: "qa-compacted-kotlin-book-file-id",
    bytes: pdfBytes,
    name: path.basename(kotlinPdfPath),
    mime: "application/pdf",
    logger,
  });
  const pdfMessage = await repos.messages.insert({
    threadId: thread.id,
    role: "user",
    kind: "file",
    content: { text: pdf.card },
    textPlain: pdf.card,
  });
  await repos.files.setMessageId(pdf.fileId, pdfMessage.id);
  const chunks = await repos.files.chunks(pdf.fileId);
  check("book-ingested", !pdf.inline && chunks.length > 500, {
    fileId: pdf.fileId,
    messageId: pdfMessage.id,
    chunks: chunks.length,
    bytes: pdfBytes.length,
  });

  for (let i = 0; i < 13; i += 1) {
    await repos.messages.insert({
      threadId: thread.id,
      role: i % 2 ? "assistant" : "user",
      content: { text: `compaction filler ${i}: keep the uploaded Android Kotlin book available for later document questions.` },
      textPlain: `compaction filler ${i}: keep the uploaded Android Kotlin book available for later document questions.`,
    });
  }

  const compaction = await compactThread(repos, thread, {
    recentWindowMessages: 1,
    embedder: { embed: (texts) => embed(texts, config) },
    summarizer: createConversationSummarizer(config, logger),
    logger,
  });
  const compacted = (await repos.threads.get(thread.id)) ?? thread;
  const visibleRows = await repos.messages.listForThreadChain(await repos.threads.chain(compacted));
  const context = await buildContext({
    config,
    repos,
    search: db.search,
    user,
    thread: compacted,
    newUserText: "audit compacted book setup",
    logger,
  });
  check("book-message-compacted-out-of-verbatim-context", compaction.count >= 10 &&
    !visibleRows.some((row) => row.id === pdfMessage.id) &&
    context.system.includes(`#${pdf.fileId}`) &&
    context.system.includes(path.basename(kotlinPdfPath)), {
    compactedCount: compaction.count,
    compactedUpto: compacted.compacted_upto_message_id,
    visibleMessageIds: visibleRows.map((row) => row.id),
    fileId: pdf.fileId,
    systemHasFileOverview: context.system.includes(`#${pdf.fileId}`),
  });
  return compacted;
}

async function runVariation(input: {
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  variation: Variation;
}): Promise<void> {
  const api = new CaptureApi();
  await runTurn({
    api: api as never,
    chatId: input.user.tg_id,
    config,
    db,
    repos: input.repos,
    logger,
    user: input.user,
    thread: input.thread,
    text: input.variation.prompt,
    embedder: { embed: (texts) => embed(texts, config) },
    t: (key, params) => localizer.t(input.user.lang, key, params),
  });
  const assistant = await input.repos.messages.latest(input.thread.id);
  const thinking = assistant?.thinking ?? "";
  const answer = assistant?.text_plain ?? "";
  const usedSearchInFile = thinking.includes("Searching file");
  const usedReadFileSection = thinking.includes("Reading file");
  const usedSearchThread = thinking.includes("Searching chat");
  check(`variation-${input.variation.name}`, Boolean(assistant) &&
    assistant?.role === "assistant" &&
    usedSearchInFile &&
    (!input.variation.requireReadSection || usedReadFileSection) &&
    (!input.variation.requireSearchThread || usedSearchThread) &&
    input.variation.expected.test(`${answer}\n${thinking}`), {
    usedSearchThread,
    usedSearchInFile,
    usedReadFileSection,
    answerPreview: answer.slice(0, 500),
    thinkingPreview: thinking.slice(0, 900),
    richMessages: api.richMessages.length,
    drafts: api.drafts.length,
  });
}
