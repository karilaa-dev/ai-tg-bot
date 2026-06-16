import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createDatabase, type AppDatabase } from "../src/db/index.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { createLogger, type Logger } from "../src/logger.js";
import { runTurn } from "../src/ai/run.js";
import { createOpenRouterTextEmbedder, persistEmbedding, type TextEmbedder } from "../src/memory/embeddings.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-live-codex-"));
const marker = `CODEX_CHECK_MARKER_${Date.now()}_SAPPHIRE`;
const question = [
  `Use the search_in_file tool on the attached file to find this exact marker: ${marker}.`,
  "Do not answer from the file list or memory alone.",
  `Final answer format: ${marker}`,
].join("\n");

const baseConfig = loadConfig({
  ...process.env,
  BOT_TOKEN: process.env.BOT_TOKEN || "TEST:TOKEN",
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || "1000",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  DRAFT_UPDATE_MS: process.env.DRAFT_UPDATE_MS || "0",
  FILE_INLINE_TOKENS: "1",
});

try {
  const result = await runCodex();
  console.log(JSON.stringify({ ok: true, marker, result }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

async function runCodex(): Promise<CodexResult> {
  const dbPath = path.join(root, "codex.sqlite");
  const config: AppConfig = {
    ...baseConfig,
    DB_URL: `sqlite:${dbPath}`,
  };
  const logger = createLogger(config);
  const db = createDatabase(config, logger);
  try {
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const embedder = createOpenRouterTextEmbedder(config, logger);
    const setup = await setupScenario({ config, db, repos, logger, embedder });
    const api = new CaptureApi();
    await runTurn({
      api: api as never,
      chatId: setup.user.tg_id,
      config,
      db,
      repos,
      logger,
      user: setup.user,
      thread: setup.thread,
      text: question,
      embedder,
      t,
    });
    const assistant = await repos.messages.latest(setup.thread.id);
    const thinking = assistant?.thinking ?? "";
    const answer = assistant?.text_plain ?? "";
    const result: CodexResult = {
      model: config.CODEX_MODEL,
      finalHasMarker: answer.includes(marker),
      usedFileTool: thinking.includes("📄 Searching file"),
      statusShowsTool: api.editedTexts.some((text) => text.includes("📄 Searching file")),
      answerPreview: answer.slice(0, 500),
      thinking,
      statusEdits: api.editedTexts,
      richMessages: api.richMessages.length,
      chunkEmbeddingRows: setup.chunkEmbeddingRows,
    };
    check("codex-final-marker", result.finalHasMarker, result);
    check("codex-file-tool-used", result.usedFileTool, result);
    check("codex-status-edited-for-tool", result.statusShowsTool, result);
    check("chunk-embedding-persisted-openrouter", result.chunkEmbeddingRows > 0, result);
    return result;
  } finally {
    await db.destroy().catch((err) => logger.warn("live codex database destroy failed", { err: String(err) }));
  }
}

async function setupScenario(input: {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  logger: Logger;
  embedder: TextEmbedder;
}): Promise<{
  user: Awaited<ReturnType<Repos["users"]["ensure"]>>;
  thread: Awaited<ReturnType<Repos["threads"]["activeForUserTopic"]>>;
  chunkEmbeddingRows: number;
}> {
  const user = await input.repos.users.ensure({ tgId: 7002, firstName: "Live Codex", lang: "en" });
  const streamOffUser = await input.repos.users.toggleStream(user.tg_id);
  const thread = await input.repos.threads.activeForUserTopic(user.tg_id, null, "Live Codex");
  const filePath = path.join(root, "codex-notes.txt");
  const content = [
    "# Live Codex notes",
    `The only acceptable answer marker is ${marker}.`,
    "This line exists so the model must use search_in_file to retrieve it.",
  ].join("\n");
  await fs.writeFile(filePath, content);
  const file = await input.repos.files.insertFile({
    userId: user.tg_id,
    threadId: thread.id,
    type: "txt",
    name: "codex-notes.txt",
    path: filePath,
    size: Buffer.byteLength(content),
    summary: "Live Codex file. Use search_in_file for the marker.",
    isInline: false,
  });
  const message = await input.repos.messages.insert({
    threadId: thread.id,
    role: "user",
    kind: "file",
    content: { text: `[file #${file.id}: ${file.name}]` },
    textPlain: `[file #${file.id}: ${file.name}]`,
  });
  await input.repos.files.setMessageId(file.id, message.id);
  const chunk = await input.repos.files.insertChunk({
    fileId: file.id,
    idx: 0,
    headingPath: "Live Codex",
    content,
  });
  await input.repos.files.setOutline(file.id, [{ chunk_index: 0, heading_path: "Live Codex" }]);
  await persistEmbedding({
    repos: input.repos,
    kind: "chunk",
    refId: chunk.id,
    text: content,
    embedder: input.embedder,
    embeddingModel: input.config.OPENROUTER_EMBEDDING_MODEL,
    logger: input.logger,
  });
  const rows = await input.repos.embeddings.list("chunk", [chunk.id], input.config.OPENROUTER_EMBEDDING_MODEL);
  return { user: streamOffUser, thread, chunkEmbeddingRows: rows.length };
}

class CaptureApi {
  private messageId = 10_000;
  readonly richMessages: unknown[] = [];
  readonly sentTexts: string[] = [];
  readonly editedTexts: string[] = [];

  readonly raw = {
    sendRichMessage: async (payload: unknown) => {
      this.richMessages.push(payload);
      return {
        message_id: this.messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 424242, type: "private", first_name: "LiveVerifier" },
      };
    },
  };

  async sendMessage(chatId: number, text: string) {
    this.sentTexts.push(text);
    return {
      message_id: this.messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "LiveVerifier" },
      text,
    };
  }

  async editMessageText(_chatId: number, _messageId: number, text: string) {
    this.editedTexts.push(text);
    return {
      message_id: _messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: _chatId, type: "private", first_name: "LiveVerifier" },
      text,
    };
  }

  async sendChatAction() {
    return true;
  }
}

interface CodexResult {
  model: string;
  finalHasMarker: boolean;
  usedFileTool: boolean;
  statusShowsTool: boolean;
  answerPreview: string;
  thinking: string;
  statusEdits: string[];
  richMessages: number;
  chunkEmbeddingRows: number;
}

function check(name: string, ok: boolean, details?: unknown): void {
  console.log(JSON.stringify({ check: name, ok, details }));
  if (!ok) throw new Error(`Live Codex check failed: ${name}`);
}

function t(key: string, params?: Record<string, string | number>): string {
  switch (key) {
    case "thinking-placeholder":
      return "💭 Thinking...";
    case "thinking-done":
      return "✅ Done.";
    case "thinking-summary":
      return `🧠 Thinking${params?.steps ? ` (${params.steps})` : ""}`;
    case "empty-answer":
      return "⚠️ No final answer returned.";
    case "error-generic":
      return "Something went wrong.";
    case "show-more":
      return "Show more";
    default:
      return key;
  }
}
