import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { classifyFile, ingestFileBytes, refreshExtractedFileBytes } from "../../src/files/ingest.js";

let bashRoot: string;

describe("file ingestion", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    bashRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-ingest-test-"));
    const config = testConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.destroy();
    await fs.rm(bashRoot, { recursive: true, force: true });
  });

  it("classifies text/csv as csv before generic text", () => {
    expect(classifyFile("airtravel.csv", "text/csv")).toBe("csv");
    expect(classifyFile("download", "text/csv")).toBe("csv");
    expect(classifyFile("notes.txt", "text/plain")).toBe("txt");
  });

  it("persists attachment bytes in the managed chat-file store", async () => {
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
    expect(stored?.path).toBe(path.join(bashRoot, ".chat-files", String(result.fileId), "content"));
    await expect(fs.readFile(stored!.path!)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await fs.stat(path.dirname(stored!.path!))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(stored!.path!)).mode & 0o777).toBe(0o600);
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

  it("persists embeddings for chunks of searchable files", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 222, firstName: "File", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config,
      repo: repos.files,
      embeddings: repos.embeddings,
      embedder: { embed: async (texts) => texts.map((text) => new Float32Array([text.length, 3])) },
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
    const embeddings = await repos.embeddings.list("chunk", chunks.map((chunk) => chunk.id));
    expect(embeddings).toHaveLength(chunks.length);
  });

  it("rebuilds durable chunks and embeddings when remote bytes change", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 225, firstName: "Refresh", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const embedder = { embed: async (texts: string[]) => texts.map((text) => new Float32Array([text.length, 7])) };
    const initial = await ingestFileBytes({
      config,
      repo: repos.files,
      embeddings: repos.embeddings,
      embedder,
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
      embeddings: repos.embeddings,
      embedder,
    });
    const newChunks = await repos.files.chunks(file.id);

    expect(refreshed.extraction_status).toBe("ready");
    expect(refreshed.content_sha256).not.toBe(file.content_sha256);
    expect(newChunks.map((chunk) => chunk.id)).not.toEqual(oldChunks.map((chunk) => chunk.id));
    expect(newChunks.map((chunk) => chunk.content).join("\n")).toContain("new indexed phrase");
    await expect(repos.embeddings.list("chunk", oldChunks.map((chunk) => chunk.id))).resolves.toEqual([]);
    await expect(repos.embeddings.list("chunk", newChunks.map((chunk) => chunk.id)))
      .resolves.toHaveLength(newChunks.length);
  });

  it("preserves the previous extraction and vectors when replacement embedding fails", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 226, firstName: "RefreshFailure", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const initial = await ingestFileBytes({
      config,
      repo: repos.files,
      embeddings: repos.embeddings,
      embedder: { embed: async (texts) => texts.map((text) => new Float32Array([text.length, 11])) },
      userId: user.tg_id,
      threadId: thread.id,
      name: "stable.txt",
      mime: "text/plain",
      bytes: Buffer.from("# Stable\n\n" + "keep this searchable phrase ".repeat(300)),
    });
    const before = (await repos.files.get(initial.fileId))!;
    const chunksBefore = await repos.files.chunks(before.id);
    const embeddingsBefore = await repos.embeddings.list("chunk", chunksBefore.map((chunk) => chunk.id));

    await expect(refreshExtractedFileBytes({
      config,
      repo: repos.files,
      file: before,
      bytes: Buffer.from("# Replacement\n\n" + "replacement phrase ".repeat(300)),
      mime: "text/plain",
      embeddings: repos.embeddings,
      embedder: { embed: async () => { throw new Error("embedding provider unavailable"); } },
    })).rejects.toThrow("embedding provider unavailable");

    const after = await repos.files.get(before.id);
    const chunksAfter = await repos.files.chunks(before.id);
    const embeddingsAfter = await repos.embeddings.list("chunk", chunksAfter.map((chunk) => chunk.id));
    expect(after).toMatchObject({
      content_sha256: before.content_sha256,
      extraction_status: "ready",
      content_md: before.content_md,
      summary: before.summary,
      outline_json: before.outline_json,
    });
    expect(chunksAfter).toEqual(chunksBefore);
    expect(embeddingsAfter).toEqual(embeddingsBefore);
  });

  it("reports chunk indexing separately from vector embedding", async () => {
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 223, firstName: "Progress", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const progress: Array<{ stage: string; completed?: number; total?: number }> = [];

    const result = await ingestFileBytes({
      config,
      repo: repos.files,
      embeddings: repos.embeddings,
      embedder: { embed: async (texts) => texts.map((text) => new Float32Array([text.length, 5])) },
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
    const embedding = progress.filter((entry) => entry.stage === "embedding");
    expect(indexing.at(-1)).toMatchObject({ completed: chunks.length, total: chunks.length });
    expect(embedding[0]).toMatchObject({ completed: 0, total: chunks.length });
    expect(embedding.at(-1)).toMatchObject({ completed: chunks.length, total: chunks.length });
  });

  it("extracts searchable text PDFs natively before falling back to docling", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("docling should not be called for native text PDFs");
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = testConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 333, firstName: "Pdf", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const pdfText = [
      "Native PDF extraction should keep Kotlin Android activity text searchable.",
      "Activity lifecycle fragments compose repositories view models and coroutines.",
      "This repeated content makes the generated PDF exceed the native extraction threshold.",
    ].join(" ").repeat(8);

    const result = await ingestFileBytes({
      config,
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "native-kotlin.pdf",
      mime: "application/pdf",
      bytes: makePdf(pdfText),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.inline).toBe(false);
    const chunks = await repos.files.chunks(result.fileId);
    expect(chunks.map((chunk) => chunk.content).join("\n")).toMatch(/Kotlin Android activity/i);
  });
});

function testConfig(overrides: Parameters<typeof loadTestConfig>[0] = {}) {
  return loadTestConfig({ BASH_WORKSPACE_ROOT: bashRoot, ...overrides });
}

function makePdf(text: string): Buffer {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 80) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const textOps = lines.map((value, index) => `${index === 0 ? "" : "T*\n"}(${escapePdfText(value)}) Tj`).join("\n");
  const stream = `BT\n/F1 12 Tf\n14 TL\n72 720 Td\n${textOps}\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
