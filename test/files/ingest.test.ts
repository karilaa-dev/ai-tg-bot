import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { classifyFile, ingestFileBytes } from "../../src/files/ingest.js";

describe("file ingestion", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.destroy();
  });

  it("classifies text/csv as csv before generic text", () => {
    expect(classifyFile("airtravel.csv", "text/csv")).toBe("csv");
    expect(classifyFile("download", "text/csv")).toBe("csv");
    expect(classifyFile("notes.txt", "text/plain")).toBe("txt");
  });

  it("ingests csv files with trailing blank lines", async () => {
    const user = await repos.users.ensure({ tgId: 221, firstName: "Csv", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);

    const result = await ingestFileBytes({
      config: loadTestConfig(),
      repo: repos.files,
      userId: user.tg_id,
      threadId: thread.id,
      name: "airtravel.csv",
      mime: "text/csv",
      bytes: Buffer.from('"Month","1958"\n"JAN",340\n\n'),
    });

    expect(result.inline).toBe(true);
    expect(result.type).toBe("csv");
    expect(result.card).toContain("1 rows");
  });

  it("persists embeddings for chunks of searchable files", async () => {
    const config = loadTestConfig({ FILE_INLINE_TOKENS: 1 });
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

  it("extracts searchable text PDFs natively before falling back to docling", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("docling should not be called for native text PDFs");
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = loadTestConfig({ FILE_INLINE_TOKENS: 1 });
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
