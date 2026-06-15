import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { buildTools } from "../../src/ai/tools/index.js";
import { ingestFileBytes } from "../../src/files/ingest.js";
import { compactThread } from "../../src/memory/compactor.js";
import { clearRetrievalVectorCacheForTests, threadChainScope } from "../../src/memory/retrieval.js";

describe("AI tools", () => {
  let db: AppDatabase;
  let repos: Repos;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    const config = loadTestConfig();
    clearRetrievalVectorCacheForTests();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
    clearRetrievalVectorCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("searches file chunks with stored embeddings when FTS has no lexical match", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 71, firstName: "Tool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "semantic.txt",
      path: "data/files/semantic.txt",
      size: 12,
      summary: "semantic file",
      isInline: false,
    });
    const chunk = await repos.files.insertChunk({
      fileId: file.id,
      idx: 0,
      headingPath: "Intro",
      content: "lexical content without the query words",
    });
    await repos.files.setOutline(file.id, [{ chunk_index: 0, heading_path: "Intro" }]);
    await repos.embeddings.upsert("chunk", chunk.id, new Float32Array([1, 0]));
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      embedder: { embed: async () => [new Float32Array([1, 0])] },
    });

    const searchInFile = tools.search_in_file as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ chunk_index?: number; heading_path?: string }> }>;
    };
    const result = await searchInFile.execute({
      file_id: file.id,
      query: "semantic-only",
      limit: 5,
    });

    expect(result.results[0]?.chunk_index).toBe(0);
    expect(result.results[0]).toMatchObject({ heading_path: "Intro" });
    const readFileSection = tools.read_file_section as unknown as {
      execute(input: unknown): Promise<{ outline: Array<{ chunk_index: number; heading_path: string }> }>;
    };
    const outline = await readFileSection.execute({ file_id: file.id, chunk_index: -1 });
    expect(outline.outline[0]).toEqual({ chunk_index: 0, heading_path: "Intro" });
  });

  it("returns message metadata from search_thread results", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 73, firstName: "ThreadTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "alpha searchable detail" },
      textPlain: "alpha searchable detail",
    });
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      embedder: { embed: async () => [new Float32Array([1, 0])] },
    });
    const searchThread = tools.search_thread as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ kind: string; message_id?: number; role?: string; date_iso?: string }> }>;
    };

    const result = await searchThread.execute({ query: "alpha", limit: 5 });

    expect(result.results[0]).toMatchObject({ kind: "message", message_id: message.id, role: "user" });
    expect(result.results[0]?.date_iso).toContain("T");
  });

  it("returns attached image metadata from load_message", async () => {
    const config = loadTestConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-tool-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "whiteboard.jpg");
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
    const user = await repos.users.ensure({ tgId: 72, firstName: "ImageTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: "[image #1: whiteboard]" },
      textPlain: "[image: whiteboard]",
    });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "image",
      telegramFileId: "telegram-image-1",
      name: "whiteboard.jpg",
      path: imagePath,
      size: 4,
      summary: "[image: whiteboard]",
      isInline: true,
    });
    const tools = buildTools({ config, db, repos, user, thread });
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<{ kind: string; images: Array<{ file_id: number; path: string; note: string }> }>;
      toModelOutput(input: unknown): Promise<{ type: string; value: Array<{ type: string; data?: string; mediaType?: string }> }>;
    };

    const result = await loadMessage.execute({ message_id: message.id });

    expect(result.kind).toBe("image");
    expect(result.images[0]).toMatchObject({
      file_id: file.id,
      path: imagePath,
    });
    expect(result.images[0]?.note).toContain("image bytes");
    const modelOutput = await loadMessage.toModelOutput({
      toolCallId: "call-1",
      input: { message_id: message.id },
      output: result,
    });
    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value.some((part) => part.type === "image-data" && part.data === Buffer.from([1, 2, 3, 4]).toString("base64") && part.mediaType === "image/jpeg")).toBe(true);
  });

  it("redownloads a Telegram image when the local cache is missing", async () => {
    const config = loadTestConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-tool-redownload-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "missing-cache.jpg");
    const user = await repos.users.ensure({ tgId: 74, firstName: "RedownloadTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: "[image #1: cached image]" },
      textPlain: "[image: cached image]",
    });
    await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "image",
      telegramFileId: "telegram-cache-file-id",
      name: "missing-cache.jpg",
      path: imagePath,
      size: 3,
      summary: "[image: cached image]",
      isInline: true,
    });
    const redownloaded = Buffer.from([7, 8, 9]);
    const seenTelegramIds: Array<string | null> = [];
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      redownloadFile: async (file) => {
        seenTelegramIds.push(file.telegram_file_id);
        return redownloaded;
      },
    });
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<unknown>;
      toModelOutput(input: unknown): Promise<{ type: string; value: Array<{ type: string; data?: string }> }>;
    };

    const result = await loadMessage.execute({ message_id: message.id });
    const modelOutput = await loadMessage.toModelOutput({ toolCallId: "call-1", input: { message_id: message.id }, output: result });

    expect(seenTelegramIds).toEqual(["telegram-cache-file-id"]);
    expect(modelOutput.value.some((part) => part.type === "image-data" && part.data === redownloaded.toString("base64"))).toBe(true);
    await expect(fs.readFile(imagePath)).resolves.toEqual(redownloaded);
  });

  it("retrieves multiple compacted file types from a forked thread", async () => {
    const inlineConfig = loadTestConfig({ FILE_INLINE_TOKENS: 1000 });
    const searchableConfig = loadTestConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 75, firstName: "MultiFile", lang: "en" });
    const parent = await repos.threads.activeForUserTopic(user.tg_id, null, "Compacted mixed files");

    const inlineNote = await attachFile({
      repos,
      config: inlineConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "small-notes.txt",
      mime: "text/plain",
      bytes: Buffer.from("INLINE-CODE-ALPHA says the release color is blue."),
      telegramFileId: "telegram-small-note-id",
    });
    const csv = await attachFile({
      repos,
      config: searchableConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "large-table.csv",
      mime: "text/csv",
      bytes: Buffer.from(
        [
          "id,name,detail",
          ...Array.from({ length: 40 }, (_, index) =>
            `${index},row-${index},${index === 27 ? "CSV_TARGET_SPROCKET requires review" : "ordinary row"}`,
          ),
        ].join("\n"),
      ),
      telegramFileId: "telegram-csv-id",
    });
    const pdf = await attachFile({
      repos,
      config: searchableConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "book-section.pdf",
      mime: "application/pdf",
      bytes: makePdf(
        "The compacted book section says SODIUM ORBIT 42 is the retrieval marker for the lifecycle chapter. ".repeat(12),
      ),
      telegramFileId: "telegram-pdf-id",
    });
    const image = await attachFile({
      repos,
      config: searchableConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "whiteboard.jpg",
      mime: "image/jpeg",
      bytes: Buffer.from([1, 3, 5, 7]),
      telegramFileId: "telegram-image-id",
      imageSummary: "whiteboard cache marker diagram",
    });

    for (let i = 0; i < 12; i += 1) {
      await repos.messages.insert({
        threadId: parent.id,
        role: i % 2 ? "assistant" : "user",
        content: { text: `compaction filler ${i}` },
        textPlain: `compaction filler ${i}`,
      });
    }
    const compaction = await compactThread(repos, parent, { recentWindowMessages: 1 });
    const compactedParent = (await repos.threads.get(parent.id)) ?? parent;
    const forkPoint = await repos.messages.latest(compactedParent.id);
    const fork = await repos.threads.create({
      userId: user.tg_id,
      topicId: 909,
      title: "Forked mixed files",
      parentThreadId: compactedParent.id,
      forkPointMessageId: forkPoint?.id ?? null,
    });

    const scope = await threadChainScope(repos, fork);
    expect(compaction.count).toBeGreaterThanOrEqual(10);
    expect(new Set(scope.fileIds)).toEqual(new Set([inlineNote.fileId, csv.fileId, pdf.fileId, image.fileId]));
    const visibleRows = await repos.messages.listForThreadChain(await repos.threads.chain(fork));
    expect(visibleRows.map((row) => row.id)).not.toContain(pdf.messageId);

    const redownloadedImage = Buffer.from([9, 8, 7, 6]);
    const redownloads: string[] = [];
    const tools = buildTools({
      config: searchableConfig,
      db,
      repos,
      user,
      thread: fork,
      embedder: { embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
      redownloadFile: async (file) => {
        redownloads.push(file.telegram_file_id ?? "");
        return redownloadedImage;
      },
    });
    const searchInFile = tools.search_in_file as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ chunk_index?: number; snippet?: string }> }>;
    };
    const readFileSection = tools.read_file_section as unknown as {
      execute(input: unknown): Promise<{ content?: string; outline?: unknown }>;
    };
    const searchThread = tools.search_thread as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ kind: string; message_id?: number; snippet?: string }> }>;
    };
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<{
        text?: string;
        files?: Array<{ file_id: number; inline: boolean; type: string }>;
        images?: Array<{ file_id: number; path: string; telegram_file_id?: string | null }>;
      }>;
      toModelOutput(input: unknown): Promise<{ type: string; value: Array<{ type: string; data?: string }> }>;
    };

    await fs.rm(pdf.file.path, { force: true });
    const pdfHits = await searchInFile.execute({ file_id: pdf.fileId, query: "SODIUM ORBIT 42", limit: 5 });
    expect(pdfHits.results[0]?.chunk_index).toEqual(expect.any(Number));
    const pdfSection = await readFileSection.execute({ file_id: pdf.fileId, chunk_index: pdfHits.results[0]!.chunk_index, count: 2 });
    expect(pdfSection.content).toMatch(/SODIUM ORBIT 42/);

    const csvHits = await searchInFile.execute({ file_id: csv.fileId, query: "CSV_TARGET_SPROCKET", limit: 5 });
    expect(csvHits.results[0]?.chunk_index).toEqual(expect.any(Number));
    const csvSection = await readFileSection.execute({ file_id: csv.fileId, chunk_index: csvHits.results[0]!.chunk_index, count: 1 });
    expect(csvSection.content).toContain("CSV_TARGET_SPROCKET");

    const inlineHits = await searchThread.execute({ query: "INLINE-CODE-ALPHA", limit: 10 });
    const inlineMessageId = inlineHits.results.find((hit) => hit.kind === "message")?.message_id;
    expect(inlineMessageId).toBe(inlineNote.messageId);
    const inlineLoaded = await loadMessage.execute({ message_id: inlineNote.messageId });
    expect(inlineLoaded.text).toContain("INLINE-CODE-ALPHA");
    expect(inlineLoaded.files?.[0]).toMatchObject({ file_id: inlineNote.fileId, inline: true, type: "txt" });

    const imageHits = await searchThread.execute({ query: "whiteboard cache marker", limit: 10 });
    const imageMessageId = imageHits.results.find((hit) => hit.kind === "message")?.message_id;
    expect(imageMessageId).toBe(image.messageId);
    await fs.rm(image.file.path, { force: true });
    const imageLoaded = await loadMessage.execute({ message_id: image.messageId });
    expect(imageLoaded.images?.[0]).toMatchObject({ file_id: image.fileId });
    const imageOutput = await loadMessage.toModelOutput({ toolCallId: "call-image", input: {}, output: imageLoaded });
    expect(redownloads).toEqual(["telegram-image-id"]);
    expect(imageOutput.value.some((part) => part.type === "image-data" && part.data === redownloadedImage.toString("base64"))).toBe(true);
    await expect(fs.readFile(image.file.path)).resolves.toEqual(redownloadedImage);
  }, 30_000);
});

async function attachFile(input: {
  repos: Repos;
  config: ReturnType<typeof loadTestConfig>;
  userId: number;
  threadId: number;
  name: string;
  mime: string;
  bytes: Buffer;
  telegramFileId: string;
  imageSummary?: string;
}): Promise<{ fileId: number; messageId: number; file: NonNullable<Awaited<ReturnType<Repos["files"]["get"]>>> }> {
  const ingested = await ingestFileBytes({
    config: input.config,
    repo: input.repos.files,
    userId: input.userId,
    threadId: input.threadId,
    telegramFileId: input.telegramFileId,
    bytes: input.bytes,
    name: input.name,
    mime: input.mime,
    imageSummary: input.imageSummary,
  });
  const message = await input.repos.messages.insert({
    threadId: input.threadId,
    role: "user",
    kind: ingested.type === "image" ? "image" : "file",
    content: { text: ingested.card },
    textPlain: ingested.card,
  });
  await input.repos.files.setMessageId(ingested.fileId, message.id);
  const file = await input.repos.files.get(ingested.fileId);
  if (!file) throw new Error(`file not found after ingest: ${ingested.fileId}`);
  return { fileId: ingested.fileId, messageId: message.id, file };
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
