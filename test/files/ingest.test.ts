import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { classifyFile, ingestFileBytes, refreshExtractedFileBytes } from "../../src/files/ingest.js";

let tempRoot: string;

describe("file ingestion", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-ingest-test-"));
    const config = testConfig();
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("classifies text/csv as csv before generic text", () => {
    expect(classifyFile("airtravel.csv", "text/csv")).toBe("csv");
    expect(classifyFile("download", "text/csv")).toBe("csv");
    expect(classifyFile("notes.txt", "text/plain")).toBe("txt");
  });

  it("persists attachment metadata without a host filesystem snapshot", async () => {
    const user = await repos.users.ensure({ tgId: 220, firstName: "Image", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const result = await ingestFileBytes({
      config: testConfig(),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "telegram.png",
      mime: "image/png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      imageSummary: "a transient Telegram image",
    });

    expect(result.type).toBe("image");
    const stored = await repos.files.get(result.fileId);
    expect(stored).toMatchObject({
      mime_type: "image/png",
    });
    expect(await repos.files.listSources(result.fileId)).toEqual([]);
  });

  it("ingests csv files with trailing blank lines", async () => {
    const user = await repos.users.ensure({ tgId: 221, firstName: "Csv", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config: testConfig(),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "airtravel.csv",
      mime: "text/csv",
      bytes: Buffer.from('"Month","1958"\n"JAN",340\n\n'),
    });

    expect(result.inline).toBe(true);
    expect(result.type).toBe("csv");
    expect(result.card).toContain("[[chat-file:");
    expect(result.card).toContain('"JAN"');
    const file = await repos.files.get(result.fileId);
    expect(file?.content_md).toContain("1 rows");

    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: result.card },
      textPlain: result.card,
    });
    await repos.files.setMessageId(result.fileId, message.id);
    await expect(db.search.searchMessages([thread.id], "JAN", 10)).resolves.toEqual([
      expect.objectContaining({ id: message.id }),
    ]);
  });

  it("persists lexical chunks for searchable text files", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 222, firstName: "File", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config,
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "large.txt",
      mime: "text/plain",
      bytes: Buffer.from("# Heading\nneedle content that should become a searchable chunk"),
    });

    expect(result.inline).toBe(false);
    const chunks = await repos.files.chunks(result.fileId);
    expect(chunks.length).toBeGreaterThan(0);
    const [file] = await repos.files.listForThreads([thread.id]);
    const outline = JSON.parse(file?.outline_json as string) as Array<{ chunk_index: number }>;
    expect(outline[0]?.chunk_index).toBe(chunks[0]?.idx);
  });

  it("rebuilds durable lexical chunks when remote bytes change", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 225, firstName: "Refresh", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const initial = await ingestFileBytes({
      config,
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "changing.txt",
      mime: "text/plain",
      bytes: Buffer.from("# Old\n\n" + "old indexed phrase ".repeat(300)),
    });
    const file = (await repos.files.get(initial.fileId))!;
    const oldChunks = await repos.files.chunks(file.id);

    const refreshed = await refreshExtractedFileBytes({
      config,
      repo: repos.files,
      file,
      bytes: Buffer.from("# New\n\n" + "new indexed phrase ".repeat(300)),
      mime: "text/plain",
    });
    const newChunks = await repos.files.chunks(file.id);

    expect(refreshed.extraction_status).toBe("ready");
    expect(refreshed.content_sha256).not.toBe(file.content_sha256);
    expect(newChunks.map((chunk) => chunk.id)).not.toEqual(oldChunks.map((chunk) => chunk.id));
    expect(newChunks.map((chunk) => chunk.content).join("\n")).toContain("new indexed phrase");
  });

  it("reports lexical chunk indexing", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 223, firstName: "Progress", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const progress: Array<{ stage: string; completed?: number; total?: number }> = [];

    const result = await ingestFileBytes({
      config,
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "progress.txt",
      mime: "text/plain",
      bytes: Buffer.from("# Heading\n\n" + "progress content ".repeat(400)),
      onStage: (stage) => {
        progress.push(stage);
      },
    });

    const chunks = await repos.files.chunks(result.fileId);
    const indexing = progress.filter((entry) => entry.stage === "indexing");
    expect(indexing.at(-1)).toMatchObject({ completed: chunks.length, total: chunks.length });
    expect(progress.every((entry) => entry.stage === "extracting" || entry.stage === "indexing")).toBe(true);
  });

  it.each([
    ["pdf", "short-note.pdf", "application/pdf"],
    ["docx", "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ] as const)("registers %s documents as source-only without host extraction", async (type, name, mime) => {
    const user = await repos.users.ensure({ tgId: 332, firstName: "SandboxDoc", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config: testConfig({ FILE_INLINE_TOKENS: 1 }),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name,
      mime,
      bytes: Buffer.from("opaque document bytes"),
    });

    expect(result.type).toBe(type);
    expect(result.inline).toBe(false);
    expect(result.card).toContain("materialize_chat_files");
    const file = await repos.files.get(result.fileId);
    expect(file).toMatchObject({ extraction_status: "source_only", content_md: null, is_inline: 0 });
    const chunks = await repos.files.chunks(result.fileId);
    expect(chunks).toEqual([]);
  });
});

function testConfig(overrides: Parameters<typeof loadTestConfig>[0] = {}) {
  return loadTestConfig(overrides);
}
