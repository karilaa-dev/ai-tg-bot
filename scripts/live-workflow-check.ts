import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { buildTools } from "../src/ai/tools/index.js";
import { createOpenRouterConversationSummarizer, createOpenRouterImageCaptioner, embed, getContextBudget } from "../src/ai/provider.js";
import { runTurn } from "../src/ai/run.js";
import { Localizer } from "../src/bot/i18n.js";
import { compactThread } from "../src/memory/compactor.js";
import { buildContext } from "../src/memory/contextBuilder.js";
import { ingestFileBytes } from "../src/files/ingest.js";
import type { MessageRow } from "../src/db/types.js";

const kotlinPdfPath = process.env.LIVE_KOTLIN_PDF ??
  "/Users/karilaa/Downloads/How to Build Android Applications with Kotlin.pdf";
const imagePath = process.env.LIVE_IMAGE_PATH ?? "/Users/karilaa/Desktop/Build.png";
const dbPath = path.resolve("data", `live-workflow-${Date.now()}.sqlite`);

const config = loadConfig({
  ...process.env,
  BOT_TOKEN: process.env.BOT_TOKEN || "TEST:TOKEN",
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || "1000",
  DB_URL: `sqlite:${dbPath}`,
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
});
const searchableFileConfig = { ...config, FILE_INLINE_TOKENS: 1 };
const logger = createLogger(config);
const db = createDatabase(config, logger);
const localizer = new Localizer();

const checks: Array<{ name: string; ok: boolean; details?: unknown }> = [];

function check(name: string, ok: boolean, details?: unknown): void {
  checks.push({ name, ok, details });
  console.log(JSON.stringify({ check: name, ok, details }));
  if (!ok) throw new Error(`Live workflow check failed: ${name}`);
}

class CaptureApi {
  private messageId = 10_000;
  readonly richMessages: unknown[] = [];
  readonly plainMessages: unknown[] = [];
  readonly drafts: unknown[] = [];

  readonly raw = {
    sendRichMessage: async (payload: unknown) => {
      this.richMessages.push(payload);
      return {
        message_id: this.messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 424242, type: "private", first_name: "LiveVerifier" },
      };
    },
    sendRichMessageDraft: async (payload: unknown) => {
      this.drafts.push(payload);
      return true;
    },
  };

  async sendMessage(chatId: number, text: string, other?: unknown) {
    this.plainMessages.push({ chatId, text, other });
    return {
      message_id: this.messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "LiveVerifier" },
      text,
    };
  }

  async sendChatAction() {
    return true;
  }
}

try {
  await db.migrate();
  const repos = createRepos(db.db, db.search);

  const budget = await getContextBudget(config, logger);
  const cachedBudget = await getContextBudget(config, logger);
  const [smokeEmbedding] = await embed(["live workflow embedding smoke"], config);
  check("openrouter-context-cache-and-embedding", budget > 0 && cachedBudget === budget && (smokeEmbedding?.length ?? 0) > 0, {
    budget,
    cachedBudget,
    embeddingDim: smokeEmbedding?.length ?? 0,
  });

  const user = await repos.users.ensure({ tgId: 424242, firstName: "LiveVerifier", lang: "en" });
  let thread = await repos.threads.activeForUserTopic(user.tg_id, null);

  const notes = await ingestFileBytes({
    config,
    repo: repos.files,
    userId: user.tg_id,
    threadId: thread.id,
    telegramFileId: "live-notes-telegram-file-id",
    bytes: Buffer.from("# Live notes\nThe small file sentinel is live-small-file-lighthouse.\n"),
    name: "live-notes.txt",
    mime: "text/plain",
  });
  const notesMessage = await repos.messages.insert({
    threadId: thread.id,
    role: "user",
    kind: "file",
    content: { text: notes.card },
    textPlain: notes.card,
  });
  await repos.files.setMessageId(notes.fileId, notesMessage.id);
  check("small-text-file-inline", notes.inline && notes.card.includes("live-small-file-lighthouse"), { fileId: notes.fileId });

  const csv = await ingestFileBytes({
    config: searchableFileConfig,
    repo: repos.files,
    userId: user.tg_id,
    threadId: thread.id,
    telegramFileId: "live-csv-telegram-file-id",
    bytes: Buffer.from([
      "id,name,detail",
      ...Array.from({ length: 60 }, (_, index) =>
        `${index},row-${index},${index === 42 ? "CSV_LIVE_TARGET_SPROCKET requires retrieval after compaction" : "ordinary row"}`,
      ),
    ].join("\n")),
    name: "live-large-table.csv",
    mime: "text/csv",
  });
  const csvMessage = await repos.messages.insert({
    threadId: thread.id,
    role: "user",
    kind: "file",
    content: { text: csv.card },
    textPlain: csv.card,
  });
  await repos.files.setMessageId(csv.fileId, csvMessage.id);
  const csvChunks = await repos.files.chunks(csv.fileId);
  check("large-csv-file-chunked", !csv.inline && csvChunks.length > 0, {
    fileId: csv.fileId,
    chunks: csvChunks.length,
  });

  let imageMessageId: number | undefined;
  let imageFileId: number | undefined;
  let imageCachePath: string | undefined;
  let imageBytesForRedownload: Buffer | undefined;
  try {
    const imageBytes = await fs.readFile(imagePath);
    imageBytesForRedownload = imageBytes;
    const imageName = path.basename(imagePath);
    const caption = await createOpenRouterImageCaptioner(config, logger).caption({
      bytes: imageBytes,
      name: imageName,
      mime: imageMediaType(imageName),
    });
    const image = await ingestFileBytes({
      config,
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      telegramFileId: "live-image-telegram-file-id",
      bytes: imageBytes,
      name: imageName,
      mime: imageMediaType(imageName),
      imageSummary: caption,
    });
    const imageMessage = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: image.card },
      textPlain: image.card,
    });
    await repos.files.setMessageId(image.fileId, imageMessage.id);
    imageMessageId = imageMessage.id;
    imageFileId = image.fileId;
    imageCachePath = (await repos.files.get(image.fileId))?.path;
    check("openrouter-image-caption-and-storage", image.inline && !caption.startsWith("[image, no vision model"), {
      fileId: image.fileId,
      messageId: imageMessage.id,
      captionPreview: caption.slice(0, 160),
    });
  } catch (err) {
    check("openrouter-image-caption-and-storage", false, { error: String(err), imagePath });
  }

  const pdfBytes = await fs.readFile(kotlinPdfPath);
  const pdf = await ingestFileBytes({
    config,
    repo: repos.files,
    userId: user.tg_id,
    threadId: thread.id,
    telegramFileId: "live-pdf-telegram-file-id",
    bytes: pdfBytes,
    name: path.basename(kotlinPdfPath),
    mime: "application/pdf",
  });
  const pdfMessage = await repos.messages.insert({
    threadId: thread.id,
    role: "user",
    kind: "file",
    content: { text: pdf.card },
    textPlain: pdf.card,
  });
  await repos.files.setMessageId(pdf.fileId, pdfMessage.id);
  const pdfChunks = await repos.files.chunks(pdf.fileId);
  check("kotlin-pdf-native-chunked", !pdf.inline && pdfChunks.length > 0, {
    fileId: pdf.fileId,
    bytes: pdfBytes.length,
    chunks: pdfChunks.length,
    firstChunkPreview: pdfChunks[0]?.content.slice(0, 120),
  });

  let tools = buildTools({ config, db, repos, user, thread });
  const webResult = await execTool<{ error?: string; results?: Array<{ title?: string; url?: string }> }>(tools.web_search, {
    query: "OpenRouter API models endpoint context_length",
    max_results: 3,
  });
  check("tavily-web-search-tool", !webResult.error && (webResult.results?.length ?? 0) > 0, {
    count: webResult.results?.length ?? 0,
    firstTitle: webResult.results?.[0]?.title,
    firstUrl: webResult.results?.[0]?.url,
  });

  const fileSearch = await execTool<{ error?: string; results?: Array<{ chunk_index?: number; snippet?: string }> }>(tools.search_in_file, {
    file_id: pdf.fileId,
    query: "Kotlin activity",
    limit: 5,
  });
  check("kotlin-pdf-search-in-file", !fileSearch.error && (fileSearch.results?.length ?? 0) > 0, {
    first: fileSearch.results?.[0],
  });

  const section = await execTool<{ content?: string }>(tools.read_file_section, {
    file_id: pdf.fileId,
    chunk_index: fileSearch.results?.[0]?.chunk_index ?? 0,
    count: 1,
  });
  check("kotlin-pdf-read-section", Boolean(section.content?.trim()), {
    preview: section.content?.slice(0, 180),
  });

  const compactedOldMessages: MessageRow[] = [];
  const largeBlock = "large-context-token-block ".repeat(900);
  for (let i = 0; i < 14; i += 1) {
    compactedOldMessages.push(await repos.messages.insert({
      threadId: thread.id,
      role: i % 2 ? "assistant" : "user",
      content: { text: `live-compaction-sentinel-${i} durable fact\n${largeBlock}` },
      textPlain: `live-compaction-sentinel-${i} durable fact\n${largeBlock}`,
    }));
  }
  const preCompactionContext = await buildContext({
    config: { ...config, MODEL_CONTEXT_TOKENS_OVERRIDE: 18_000 },
    repos,
    search: db.search,
    user,
    thread,
    newUserText: "large context before compaction",
    logger,
  });
  check("large-context-over-budget-before-compaction", preCompactionContext.overBudget, {
    tokensEst: preCompactionContext.tokensEst,
  });
  const compaction = await compactThread(repos, thread, {
    recentWindowMessages: 1,
    embedder: { embed: (texts) => embed(texts, config) },
    summarizer: createOpenRouterConversationSummarizer(config, logger),
    logger,
  });
  thread = (await repos.threads.get(thread.id)) ?? thread;
  check("openrouter-compaction-summary", compaction.count >= 10 && Boolean(thread.meta_summary?.trim()), {
    compactionModel: config.OPENROUTER_COMPACTION_MODEL,
    compactedCount: compaction.count,
    compactedUpto: thread.compacted_upto_message_id,
    summaryPreview: thread.meta_summary?.slice(0, 180),
  });

  tools = buildTools({ config, db, repos, user, thread });
  const threadSearch = await execTool<{ results?: Array<{ kind: string; message_id?: number; snippet?: string }> }>(tools.search_thread, {
    query: "live-compaction-sentinel-0",
    limit: 5,
  });
  check("compacted-message-search-thread", (threadSearch.results ?? []).some((hit) => hit.message_id === compactedOldMessages[0]?.id), {
    results: threadSearch.results?.slice(0, 3),
  });

  const loaded = await execTool<{ error?: string; message_id?: number; text?: string }>(tools.load_message, {
    message_id: compactedOldMessages[0]!.id,
  });
  check("compacted-message-load-message", !loaded.error && Boolean(loaded.text?.includes("live-compaction-sentinel-0")), {
    messageId: loaded.message_id,
  });

  if (imageMessageId) {
    const loadedImage = await execTool<{ images?: unknown[] }>(tools.load_message, { message_id: imageMessageId });
    const modelOutput = await (tools.load_message as unknown as {
      toModelOutput(args: unknown): Promise<{ type: string; value?: Array<{ type: string }> }>;
    }).toModelOutput({ toolCallId: "live-image", input: { message_id: imageMessageId }, output: loadedImage });
    check("image-load-message-model-output", modelOutput.type === "content" && Boolean(modelOutput.value?.some((part) => part.type === "image-data")), {
      imageCount: loadedImage.images?.length ?? 0,
    });
  }

  const forkPoint = await repos.messages.latest(thread.id);
  const fork = await repos.threads.create({
    userId: user.tg_id,
    topicId: 778,
    title: "Forked compacted mixed files",
    parentThreadId: thread.id,
    forkPointMessageId: forkPoint?.id ?? null,
  });
  const redownloadedIds: string[] = [];
  const forkTools = buildTools({
    config,
    db,
    repos,
    user,
    thread: fork,
    redownloadFile: async (file) => {
      redownloadedIds.push(file.telegram_file_id ?? "");
      if (file.id === imageFileId && imageBytesForRedownload) return imageBytesForRedownload;
      throw new Error(`no live redownload fixture for file ${file.id}`);
    },
  });
  const forkPdfSearch = await execTool<{ results?: Array<{ chunk_index?: number; snippet?: string }> }>(forkTools.search_in_file, {
    file_id: pdf.fileId,
    query: "Kotlin activity",
    limit: 5,
  });
  const forkPdfSection = await execTool<{ content?: string }>(forkTools.read_file_section, {
    file_id: pdf.fileId,
    chunk_index: forkPdfSearch.results?.[0]?.chunk_index ?? 0,
    count: 1,
  });
  check("fork-compacted-pdf-retrieval", (forkPdfSearch.results?.length ?? 0) > 0 && Boolean(forkPdfSection.content?.trim()), {
    first: forkPdfSearch.results?.[0],
    sectionPreview: forkPdfSection.content?.slice(0, 180),
  });

  const forkCsvSearch = await execTool<{ results?: Array<{ chunk_index?: number; snippet?: string }> }>(forkTools.search_in_file, {
    file_id: csv.fileId,
    query: "CSV_LIVE_TARGET_SPROCKET",
    limit: 5,
  });
  const forkCsvSection = await execTool<{ content?: string }>(forkTools.read_file_section, {
    file_id: csv.fileId,
    chunk_index: forkCsvSearch.results?.[0]?.chunk_index ?? 0,
    count: 1,
  });
  check("fork-compacted-csv-retrieval", Boolean(forkCsvSection.content?.includes("CSV_LIVE_TARGET_SPROCKET")), {
    first: forkCsvSearch.results?.[0],
  });

  const forkNotesSearch = await execTool<{ results?: Array<{ kind: string; message_id?: number; snippet?: string }> }>(forkTools.search_thread, {
    query: "live-small-file-lighthouse",
    limit: 5,
  });
  const forkNotesLoaded = await execTool<{ text?: string; files?: Array<{ file_id: number; inline: boolean }> }>(forkTools.load_message, {
    message_id: notesMessage.id,
  });
  check("fork-compacted-inline-file-load", Boolean(
    forkNotesSearch.results?.some((hit) => hit.message_id === notesMessage.id) &&
    forkNotesLoaded.text?.includes("live-small-file-lighthouse") &&
    forkNotesLoaded.files?.some((file) => file.file_id === notes.fileId && file.inline),
  ), {
    search: forkNotesSearch.results?.slice(0, 3),
  });

  if (imageMessageId && imageCachePath) {
    await fs.rm(imageCachePath, { force: true });
    const forkLoadedImage = await execTool<{ images?: unknown[] }>(forkTools.load_message, { message_id: imageMessageId });
    const forkImageOutput = await (forkTools.load_message as unknown as {
      toModelOutput(args: unknown): Promise<{ type: string; value?: Array<{ type: string; data?: string }> }>;
    }).toModelOutput({ toolCallId: "live-fork-image", input: { message_id: imageMessageId }, output: forkLoadedImage });
    check("fork-compacted-image-redownload", redownloadedIds.includes("live-image-telegram-file-id") &&
      forkImageOutput.type === "content" &&
      Boolean(forkImageOutput.value?.some((part) => part.type === "image-data")), {
      redownloadedIds,
      imageCount: forkLoadedImage.images?.length ?? 0,
    });
  }

  const context = await buildContext({
    config: { ...config, MODEL_CONTEXT_TOKENS_OVERRIDE: 18_000 },
    repos,
    search: db.search,
    user,
    thread,
    newUserText: "live context audit",
    logger,
  });
  check("context-after-compaction", !context.overBudget && context.messages.every((message) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return !content.includes("live-compaction-sentinel-0");
  }), {
    tokensEst: context.tokensEst,
    overBudget: context.overBudget,
    messageCount: context.messages.length,
  });

  const isolatedThread = await repos.threads.create({
    userId: user.tg_id,
    topicId: 777,
    title: "Isolated topic",
  });
  await repos.messages.insert({
    threadId: isolatedThread.id,
    role: "user",
    content: { text: "isolated-topic-only-sentinel" },
    textPlain: "isolated-topic-only-sentinel",
  });
  const isolatedTools = buildTools({ config, db, repos, user, thread: isolatedThread });
  const isolatedSearch = await execTool<{ results?: Array<{ snippet?: string }> }>(isolatedTools.search_thread, {
    query: "live-compaction-sentinel-0",
    limit: 5,
  });
  check("isolated-topic-does-not-see-other-thread", !(isolatedSearch.results ?? []).some((hit) => hit.snippet?.includes("live-compaction-sentinel-0")), {
    resultCount: isolatedSearch.results?.length ?? 0,
  });

  const api = new CaptureApi();
  await runTurn({
    api: api as never,
    chatId: user.tg_id,
    config,
    db,
    repos,
    logger,
    user,
    thread,
    text: [
      "Use tools before answering.",
      `1. search_thread for live-compaction-sentinel-0.`,
      `2. search_in_file file_id ${pdf.fileId} for Kotlin activity.`,
      "3. web_search for OpenRouter models API context_length.",
      "Reply with one short status line for each tool.",
    ].join("\n"),
    embedder: { embed: (texts) => embed(texts, config) },
    t: (key, params) => localizer.t(user.lang, key, params),
  });
  const latestAssistant = await repos.messages.latest(thread.id);
  const thinking = latestAssistant?.thinking ?? "";
  check("live-runturn-tool-workflow", latestAssistant?.role === "assistant" &&
    api.richMessages.length > 0 &&
    ["Searching chat", "Searching file", "Searching web"].every((label) => thinking.includes(label)), {
    responsePreview: latestAssistant?.text_plain.slice(0, 400),
    thinkingPreview: thinking.slice(0, 400),
    richMessages: api.richMessages.length,
  });

  console.log(JSON.stringify({ ok: true, checks: checks.length, dbPath }));
} finally {
  await db.destroy().catch(() => undefined);
}

async function execTool<T>(tool: unknown, input: unknown): Promise<T> {
  return (tool as { execute(args: unknown, options?: unknown): Promise<T> }).execute(input, {
    toolCallId: "live-tool",
    messages: [],
  });
}

function imageMediaType(name: string): string | undefined {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return undefined;
}
