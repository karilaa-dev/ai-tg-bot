import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { parse } from "csv-parse/sync";
import type { AppConfig } from "../config.js";
import type { EmbeddingsRepo } from "../db/repos/embeddings.js";
import type { FilesRepo } from "../db/repos/files.js";
import type { FileChunkRow, FileRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { TextEmbedder } from "../memory/embeddings.js";
import { chunkCsv, chunkMarkdown } from "./chunker.js";
import { isAbortError, throwIfAborted } from "./cancel.js";
import { convertWithDocling } from "./docling.js";
import { extractPdfText } from "./pdfText.js";

export type AcceptedFileType = "txt" | "csv" | "pdf" | "docx" | "image";
export type FileIngestStage = "extracting" | "indexing";
export interface FileIngestProgress {
  stage: FileIngestStage;
  completed?: number;
  total?: number;
}
export type FileIngestStageReporter = (progress: FileIngestProgress) => void | Promise<void>;

export function classifyFile(name: string, mime = ""): AcceptedFileType | "legacy-doc" | null {
  if (/\.doc$/i.test(name)) return "legacy-doc";
  if (/\.csv$/i.test(name) || mime === "text/csv") return "csv";
  if (/\.txt$/i.test(name) || /^text\//.test(mime)) return "txt";
  if (/\.pdf$/i.test(name) || mime === "application/pdf") return "pdf";
  if (/\.docx$/i.test(name) || mime.includes("wordprocessingml.document")) return "docx";
  if (/\.(jpe?g|png|webp)$/i.test(name) || /^image\/(jpeg|png|webp)$/.test(mime)) return "image";
  return null;
}

export async function ingestLocalFile(input: {
  config: AppConfig;
  repo: FilesRepo;
  userId: number;
  threadId: number;
  messageId?: number | null;
  telegramFileId?: string | null;
  telegramFileUniqueId?: string | null;
  sourcePath: string;
  name: string;
  mime?: string;
}): Promise<{ fileId: number; card: string }> {
  const bytes = await fs.readFile(input.sourcePath);
  return ingestFileBytes({
    config: input.config,
    repo: input.repo,
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId,
    telegramFileId: input.telegramFileId,
    telegramFileUniqueId: input.telegramFileUniqueId,
    bytes,
    name: input.name,
    mime: input.mime,
  });
}

export async function ingestFileBytes(input: {
  config: AppConfig;
  repo: FilesRepo;
  userId: number;
  threadId: number;
  messageId?: number | null;
  telegramFileId?: string | null;
  telegramFileUniqueId?: string | null;
  bytes: Buffer | Uint8Array;
  name: string;
  mime?: string;
  imageSummary?: string | null;
  embeddings?: EmbeddingsRepo;
  embedder?: TextEmbedder;
  logger?: Logger;
  signal?: AbortSignal;
  onStage?: FileIngestStageReporter;
}): Promise<{ fileId: number; card: string; inline: boolean; type: AcceptedFileType }> {
  const type = classifyFile(input.name, input.mime);
  if (!type || type === "legacy-doc") throw new Error(`unsupported file type: ${type ?? "unknown"}`);
  const ext = path.extname(input.name).toLowerCase() || `.${type}`;
  const outDir = path.resolve("data/files");
  let dest: string | undefined;
  let fileId: number | undefined;
  let chunkIds: number[] = [];
  let completed = false;
  const cleanup = async () => {
    if (fileId !== undefined) {
      const existingChunkIds = await input.repo.deleteFile(fileId);
      chunkIds = chunkIds.length ? chunkIds : existingChunkIds;
    }
    if (input.embeddings && chunkIds.length) await input.embeddings.deleteRefs("chunk", chunkIds);
    if (dest) await fs.unlink(dest).catch(() => undefined);
  };
  try {
    throwIfAborted(input.signal);
    await fs.mkdir(outDir, { recursive: true });
    dest = path.join(outDir, `${nanoid()}${ext}`);
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    await fs.writeFile(dest, bytes);
    throwIfAborted(input.signal);

    if (type === "image") {
      await reportStage(input.onStage, { stage: "indexing", completed: 1, total: 1 }, input.signal);
      const file = await input.repo.insertFile({
        userId: input.userId,
        threadId: input.threadId,
        messageId: input.messageId ?? null,
        telegramFileId: input.telegramFileId ?? null,
        telegramFileUniqueId: input.telegramFileUniqueId ?? null,
        type,
        name: input.name,
        path: dest,
        size: bytes.length,
        summary: input.imageSummary ?? `[image: ${input.name}]`,
        isInline: true,
      });
      fileId = file.id;
      completed = true;
      return {
        fileId: file.id,
        card: cardForFile(file, [], input.name),
        inline: true,
        type,
      };
    }

    await reportStage(input.onStage, { stage: "extracting" }, input.signal);
    const content = await contentFor(type, input.name, bytes, input.config, input.logger, input.signal);
    throwIfAborted(input.signal);
    const inline = content.length <= input.config.FILE_INLINE_TOKENS * 4;
    const chunks = inline ? [] : type === "csv" ? chunkCsv(content) : chunkMarkdown(content);
    await reportStage(input.onStage, {
      stage: "indexing",
      completed: inline ? 1 : 0,
      total: inline ? 1 : Math.max(1, chunks.length),
    }, input.signal);
    const file = await input.repo.insertFile({
      userId: input.userId,
      threadId: input.threadId,
      messageId: input.messageId ?? null,
      telegramFileId: input.telegramFileId ?? null,
      telegramFileUniqueId: input.telegramFileUniqueId ?? null,
      type,
      name: input.name,
      path: dest,
      size: bytes.length,
      contentMd: inline ? content : null,
      summary: firstLine(content),
      isInline: inline,
    });
    fileId = file.id;
    if (!inline) {
      const outline: Array<{ chunk_index: number; heading_path: string | null }> = [];
      const insertedChunks: Array<{ id: number; content: string }> = [];
      const totalIndexingSteps = chunks.length + (input.embeddings && input.embedder ? chunks.length : 0);
      let completedIndexingSteps = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        throwIfAborted(input.signal);
        const inserted = await input.repo.insertChunk({ fileId: file.id, idx: chunk.idx, headingPath: chunk.headingPath, content: chunk.content });
        chunkIds.push(inserted.id);
        insertedChunks.push({ id: inserted.id, content: inserted.content });
        outline.push({ chunk_index: inserted.idx, heading_path: inserted.heading_path });
        completedIndexingSteps += 1;
        await reportStage(input.onStage, {
          stage: "indexing",
          completed: completedIndexingSteps,
          total: totalIndexingSteps,
        }, input.signal);
      }
      if (input.embeddings && input.embedder && insertedChunks.length) {
        await persistChunkEmbeddings({
          embeddings: input.embeddings,
          chunks: insertedChunks,
          embedder: input.embedder,
          embeddingModel: input.config.OPENROUTER_EMBEDDING_MODEL,
          logger: input.logger,
          signal: input.signal,
        });
        completedIndexingSteps += insertedChunks.length;
        await reportStage(input.onStage, {
          stage: "indexing",
          completed: completedIndexingSteps,
          total: totalIndexingSteps,
        }, input.signal);
      }
      throwIfAborted(input.signal);
      await input.repo.setOutline(file.id, outline);
      completed = true;
      return {
        fileId: file.id,
        card: cardForFile(
          { ...file, outline_json: JSON.stringify(outline) },
          chunks.map((chunk) => ({ idx: chunk.idx, heading_path: chunk.headingPath })),
          input.name,
        ),
        inline: false,
        type,
      };
    }
    completed = true;
    return { fileId: file.id, card: cardForFile(file, [], input.name), inline: true, type };
  } catch (err) {
    if (!completed) await cleanup();
    throw err;
  }
}

export function cardForFile(
  file: FileRow,
  chunks: Pick<FileChunkRow, "idx" | "heading_path">[] = [],
  displayName = file.name,
): string {
  if (file.type === "image") return `[image #${file.id}: ${file.summary ?? displayName}]`;
  if (file.is_inline) return `\`\`\`${file.type} name=${displayName}\n${file.content_md ?? ""}\n\`\`\``;
  const outline = decodeOutline(file.outline_json) ?? chunks.map((chunk) => ({
    chunk_index: chunk.idx,
    heading_path: chunk.heading_path,
  }));
  return [
    `File #${file.id}: ${displayName} (${file.type}, ${chunks.length} chunks). ${file.summary ?? ""}`.trim(),
    outlinePreview(outline),
    "Use search_in_file or read_file_section.",
  ].filter(Boolean).join(" ");
}

async function persistChunkEmbeddings(input: {
  embeddings: EmbeddingsRepo;
  chunks: Array<{ id: number; content: string }>;
  embedder: TextEmbedder;
  embeddingModel: string;
  logger?: Logger;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  try {
    const vectors = await input.embedder.embed(input.chunks.map((chunk) => chunk.content));
    throwIfAborted(input.signal);
    for (let i = 0; i < input.chunks.length; i += 1) {
      const chunk = input.chunks[i]!;
      const vector = vectors[i];
      if (vector) await input.embeddings.upsert("chunk", chunk.id, vector, input.embeddingModel);
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    input.logger?.warn("chunk embedding persistence failed", {
      chunks: input.chunks.length,
      err: String(err),
    });
  }
}

async function contentFor(
  type: AcceptedFileType,
  name: string,
  bytes: Buffer,
  config: AppConfig,
  logger?: Logger,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (type === "txt") return bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (type === "csv") {
    const raw = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const rows = parse(raw, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
    const columns = rows[0]?.join(", ") ?? "";
    return `columns: ${columns} · ${Math.max(0, rows.length - 1)} rows\n\n${raw}`;
  }
  if (type === "pdf") {
    try {
      const native = await extractPdfText({ bytes, signal });
      if (native.textChars >= 500) {
        return [
          `# ${name}`,
          `Extracted with native PDF text extraction (${native.pages} pages, ${native.textChars} text characters).`,
          native.markdown,
        ].join("\n\n");
      }
      logger?.warn("native PDF text extraction returned little text; falling back to docling", {
        name,
        pages: native.pages,
        textChars: native.textChars,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      logger?.warn("native PDF text extraction failed; falling back to docling", { err: String(err), name });
    }
  }
  return convertWithDocling({ config, filename: name, bytes, signal });
}

async function reportStage(
  onStage: FileIngestStageReporter | undefined,
  progress: FileIngestProgress,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await onStage?.(progress);
  throwIfAborted(signal);
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "";
}

function outlinePreview(outline: Array<{ chunk_index: number; heading_path: string | null }>): string {
  const headings = outline
    .map((entry) => entry.heading_path || `chunk ${entry.chunk_index}`)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 5);
  return headings.length ? `Outline: ${headings.join(" | ")}.` : "";
}

function decodeOutline(raw: string | null): Array<{ chunk_index: number; heading_path: string | null }> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as { chunk_index?: unknown; heading_path?: unknown };
        if (typeof record.chunk_index !== "number") return null;
        return {
          chunk_index: record.chunk_index,
          heading_path: typeof record.heading_path === "string" ? record.heading_path : null,
        };
      })
      .filter((entry): entry is { chunk_index: number; heading_path: string | null } => Boolean(entry));
  } catch {
    return null;
  }
}
