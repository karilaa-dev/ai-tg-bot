import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { createLogger } from "../src/logger.js";
import { buildTools } from "../src/ai/tools/index.js";
import { ingestFileBytes } from "../src/files/ingest.js";

const sampleDir = process.argv[2] ?? "/tmp/ai-tg-bot-samples";
const dbPath = path.resolve("data", `external-samples-${Date.now()}.sqlite`);
const config = loadConfig({
  ...process.env,
  BOT_TOKEN: process.env.BOT_TOKEN || "TEST:TOKEN",
  TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || "1000",
  DB_URL: `sqlite:${dbPath}`,
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
});
const searchableConfig = { ...config, FILE_INLINE_TOKENS: 1 };
const logger = createLogger(config);
const db = createDatabase(config, logger);

type Sample = {
  name: string;
  mime: string;
  source: string;
  config: AppConfig;
  imageSummary?: string;
};

const samples: Sample[] = [
  {
    name: "demo.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    source: path.join(sampleDir, "demo.docx"),
    config: searchableConfig,
  },
  {
    name: "airtravel.csv",
    mime: "text/csv",
    source: path.join(sampleDir, "airtravel.csv"),
    config: searchableConfig,
  },
  {
    name: "sample-local-pdf.pdf",
    mime: "application/pdf",
    source: path.join(sampleDir, "sample-local-pdf.pdf"),
    config: searchableConfig,
  },
  {
    name: "bali.jpg",
    mime: "image/jpeg",
    source: path.join(sampleDir, "bali.jpg"),
    config,
    imageSummary: "public sample JPEG of a Bali scene",
  },
];

try {
  await db.migrate();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 515151, firstName: "ExternalSamples", lang: "en" });
  const thread = await repos.threads.activeForUserTopic(user.tg_id, null, "External samples");
  const tools = buildTools({
    config,
    db,
    repos,
    user,
    thread,
    embedder: { embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
  });
  const results = [];
  for (const sample of samples) {
    results.push(await ingestSample(repos, sample, user.tg_id, thread.id, tools.search_in_file));
  }
  const ok = results.every((result) => result.type === "image" || result.inline || result.chunks > 0) &&
    results.filter((result) => result.type !== "image" && !result.inline).every((result) => result.searchHit);
  console.log(JSON.stringify({ ok, dbPath, results }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await db.destroy().catch(() => undefined);
}

async function ingestSample(
  repos: Repos,
  sample: Sample,
  userId: number,
  threadId: number,
  searchInFileTool: unknown,
): Promise<{
  name: string;
  type: string;
  bytes: number;
  inline: boolean;
  chunks: number;
  searchHit: boolean;
  cardPreview: string;
}> {
  const bytes = await fs.readFile(sample.source);
  const ingested = await ingestFileBytes({
    config: sample.config,
    repo: repos.files,
    userId,
    threadId,
    telegramFileId: `external-${sample.name}`,
    bytes,
    name: sample.name,
    mime: sample.mime,
    imageSummary: sample.imageSummary,
  });
  const message = await repos.messages.insert({
    threadId,
    role: "user",
    kind: ingested.type === "image" ? "image" : "file",
    content: { text: ingested.card },
    textPlain: ingested.card,
  });
  await repos.files.setMessageId(ingested.fileId, message.id);
  const chunks = await repos.files.chunks(ingested.fileId);
  let searchHit = false;
  if (!ingested.inline && ingested.type !== "image") {
    const query = ingested.type === "csv" ? "JAN" : ingested.type === "pdf" ? "Sample PDF" : "calibre";
    const search = await execTool<{ results?: unknown[]; error?: string }>(searchInFileTool, {
      file_id: ingested.fileId,
      query,
      limit: 3,
    });
    searchHit = !search.error && Boolean(search.results?.length);
  }
  return {
    name: sample.name,
    type: ingested.type,
    bytes: bytes.length,
    inline: ingested.inline,
    chunks: chunks.length,
    searchHit,
    cardPreview: ingested.card.slice(0, 140),
  };
}

async function execTool<T>(tool: unknown, input: unknown): Promise<T> {
  return (tool as { execute(args: unknown, options?: unknown): Promise<T> }).execute(input, {
    toolCallId: "external-sample-tool",
    messages: [],
  });
}
