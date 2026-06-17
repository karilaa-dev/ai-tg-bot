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
const bashMarker = `BASH_CHECK_MARKER_${Date.now()}_TOPAZ`;
const pi100Decimal = "3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679";
const question = [
  `Use the search_in_file tool on the attached file to find this exact marker: ${marker}.`,
  "Do not answer from the file list or memory alone.",
  `Final answer format: ${marker}`,
].join("\n");
const bashQuestion = [
  "Use the bash tool before answering.",
  "Run exactly this bash script:",
  "js-exec -c 'console.log(42)'; python3 -c 'print(42)'; curl -s https://api.pi.delivery/v1/pi?start=0\\&numberOfDigits=2",
  `If the JavaScript output is 42, the Python output is 42, and curl returns digits starting with 31, reply exactly: ${bashMarker}`,
].join("\n");
const piQuestion = "Calculate first 100 digits of Pi using js, and then using python. Then search internet to verify results";

const baseConfig = loadConfig({
  ...process.env,
  BOT_TOKEN: process.env.BOT_TOKEN || "TEST:TOKEN",
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || "1000",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  DRAFT_UPDATE_MS: process.env.DRAFT_UPDATE_MS || "0",
  FILE_INLINE_TOKENS: "1",
});

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

    await runTurn({
      api: api as never,
      chatId: setup.user.tg_id,
      config,
      db,
      repos,
      logger,
      user: setup.user,
      thread: setup.thread,
      text: bashQuestion,
      embedder,
      t,
    });
    const bashAssistant = await repos.messages.latest(setup.thread.id);
    const bashThinking = bashAssistant?.thinking ?? "";
    const bashAnswer = bashAssistant?.text_plain ?? "";
    result.bashFinalHasMarker = bashAnswer.includes(bashMarker);
    result.bashUsedTool = bashThinking.includes("🐚 Running bash");
    result.bashThinkingShowsScript = ["js-exec", "python3", "curl"].every((token) => bashThinking.includes(token));
    result.bashStatusShowsScript = ["js-exec", "python3", "curl"].every((token) =>
      api.editedTexts.some((text) => text.includes("🐚 Running bash") && text.includes(token)),
    );
    result.bashAnswerPreview = bashAnswer.slice(0, 500);
    result.bashThinking = bashThinking;
    result.statusEdits = api.editedTexts;
    result.richMessages = api.richMessages.length;
    check("codex-bash-final-marker", result.bashFinalHasMarker, result);
    check("codex-bash-tool-used", result.bashUsedTool, result);
    check("codex-bash-thinking-shows-js-python-curl", result.bashThinkingShowsScript, result);
    check("codex-bash-status-shows-js-python-curl", result.bashStatusShowsScript, result);

    const piThread = await repos.threads.activeForUserTopic(setup.user.tg_id, 314159, "Live Pi");
    await runTurn({
      api: api as never,
      chatId: setup.user.tg_id,
      config,
      db,
      repos,
      logger,
      user: setup.user,
      thread: piThread,
      text: piQuestion,
      embedder,
      t,
    });
    const piAssistant = await repos.messages.latest(piThread.id);
    const piThinking = piAssistant?.thinking ?? "";
    const piAnswer = piAssistant?.text_plain ?? "";
    const piFirstCodeBlock = firstCodeBlock(piAnswer);
    result.piFinalUsesDecimalConvention = piFirstCodeBlock.includes(pi100Decimal);
    result.piUsedBash = piThinking.includes("🐚 Running bash");
    result.piUsedInternetTool = ["🔎 Searching web", "🌐 Reading page", "curl"].some((token) => piThinking.includes(token));
    result.piAnswerPreview = piAnswer.slice(0, 700);
    result.piThinkingPreview = piThinking.slice(0, 1200);
    check("codex-pi-decimal-convention", result.piFinalUsesDecimalConvention, result);
    check("codex-pi-used-bash", result.piUsedBash, result);
    check("codex-pi-used-internet-verification", result.piUsedInternetTool, result);
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
  bashFinalHasMarker?: boolean;
  bashUsedTool?: boolean;
  bashThinkingShowsScript?: boolean;
  bashStatusShowsScript?: boolean;
  piFinalUsesDecimalConvention?: boolean;
  piUsedBash?: boolean;
  piUsedInternetTool?: boolean;
  bashAnswerPreview?: string;
  bashThinking?: string;
  piAnswerPreview?: string;
  piThinkingPreview?: string;
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

function firstCodeBlock(text: string): string {
  return text.match(/```(?:[^\n]*)\n([\s\S]*?)```/)?.[1] ?? text.slice(0, 700);
}

function t(key: string, params?: Record<string, string | number>): string {
  switch (key) {
    case "thinking-placeholder":
      return "💭 Thinking...";
    case "thinking-done":
      return "✅ Done.";
    case "thinking-summary-running":
      return `🧠 Thinking for ${params?.time}`;
    case "thinking-summary-final":
      return `🧠 Thought for ${params?.time}`;
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

try {
  const result = await runCodex();
  console.log(JSON.stringify({ ok: true, marker, bashMarker, result }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

// Real provider clients may leave keep-alive handles open after all checks pass.
process.exit(0);
