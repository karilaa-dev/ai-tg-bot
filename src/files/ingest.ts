import { parse } from "csv-parse/sync";
import type { AppConfig } from "../config.js";
import type { FilesRepo } from "../db/repos/files.js";
import type { FileChunkRow, FileRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { isAbortError, throwIfAborted } from "./cancel.js";
import { chunkCsv, chunkMarkdown } from "./chunker.js";
import { chatFileMarker } from "./contextMarker.js";
import { sha256Hex } from "./hash.js";

const APPROX_CHARS_PER_TOKEN = 4;
const FILE_SUMMARY_MAX_CHARS = 180;
const OUTLINE_PREVIEW_HEADINGS = 5;

export type AcceptedFileType = "txt" | "csv" | "pdf" | "docx" | "image";
type FileIngestStage = "extracting" | "indexing";
export interface FileIngestProgress {
  stage: FileIngestStage;
  completed?: number;
  total?: number;
}
type FileIngestStageReporter = (progress: FileIngestProgress) => void | Promise<void>;

export function classifyFile(name: string, mime = ""): AcceptedFileType | "legacy-doc" | null {
  if (/\.doc$/i.test(name)) return "legacy-doc";
  if (/\.csv$/i.test(name) || mime === "text/csv") return "csv";
  if (/\.txt$/i.test(name) || /^text\//.test(mime)) return "txt";
  if (/\.pdf$/i.test(name) || mime === "application/pdf") return "pdf";
  if (/\.docx$/i.test(name) || mime.includes("wordprocessingml.document")) return "docx";
  if (/\.(jpe?g|png|webp)$/i.test(name) || /^image\/(jpeg|png|webp)$/.test(mime)) return "image";
  return null;
}

interface FileIngestInput {
  config: AppConfig;
  repo: FilesRepo;
  userId: number;
  threadId: number;
  messageId?: number | null;
  contentSha256?: string | null;
  bytes: Buffer | Uint8Array;
  name: string;
  mime?: string;
  imageSummary?: string | null;
  logger?: Logger;
  signal?: AbortSignal;
  onStage?: FileIngestStageReporter;
}

interface FileIngestResult {
  fileId: number;
  card: string;
  inline: boolean;
  type: AcceptedFileType;
}

interface FileRefreshInput {
  config: AppConfig;
  repo: FilesRepo;
  file: FileRow;
  bytes: Buffer | Uint8Array;
  mime?: string | null;
  logger?: Logger;
  signal?: AbortSignal;
  onStage?: FileIngestStageReporter;
}

export async function ingestFileBytes(input: FileIngestInput): Promise<FileIngestResult> {
  const type = classifyFile(input.name, input.mime);
  if (!type || type === "legacy-doc") throw new Error(`unsupported file type: ${type ?? "unknown"}`);
  const startedAt = Date.now();
  input.logger?.info("file ingest starting", {
    name: input.name,
    type,
    bytes: input.bytes.byteLength,
    userId: input.userId,
    threadId: input.threadId,
  });
  if (type === "image") {
    throwIfAborted(input.signal);
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    const file = await input.repo.insertFile({
      userId: input.userId,
      threadId: input.threadId,
      messageId: input.messageId ?? null,
      contentSha256: input.contentSha256 ?? sha256Hex(bytes),
      mimeType: input.mime ?? null,
      type,
      name: input.name,
      size: bytes.length,
      summary: input.imageSummary ?? null,
      isInline: true,
    });
    input.logger?.info("image ingest complete", {
      fileId: file.id,
      name: input.name,
      bytes: bytes.length,
      ms: Date.now() - startedAt,
    });
    return { fileId: file.id, card: cardForFile(file, [], input.name), inline: true, type };
  }
  if (type === "pdf" || type === "docx") {
    throwIfAborted(input.signal);
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    const file = await input.repo.insertFile({
      userId: input.userId,
      threadId: input.threadId,
      messageId: input.messageId ?? null,
      contentSha256: input.contentSha256 ?? sha256Hex(bytes),
      mimeType: input.mime ?? null,
      extractionStatus: "source_only",
      type,
      name: input.name,
      size: bytes.length,
      summary: sandboxDocumentSummary(type),
      isInline: false,
    });
    input.logger?.info("sandbox document registered", {
      fileId: file.id,
      name: input.name,
      type,
      bytes: bytes.length,
      ms: Date.now() - startedAt,
    });
    return { fileId: file.id, card: cardForFile(file, [], input.name), inline: false, type };
  }
  let fileId: number | undefined;
  const chunkIds: number[] = [];
  let completed = false;
  const cleanup = async () => {
    if (fileId !== undefined) {
      const existingChunkIds = await input.repo.deleteFile(fileId);
      if (!chunkIds.length) chunkIds.push(...existingChunkIds);
    }
  };
  const finish = async (file: FileRow, card: string, inline: boolean, logDetail: Record<string, unknown>): Promise<FileIngestResult> => {
    completed = true;
    input.logger?.info("file ingest complete", {
      fileId: file.id,
      name: input.name,
      type,
      inline,
      ...logDetail,
      ms: Date.now() - startedAt,
    });
    return { fileId: file.id, card, inline, type };
  };
  try {
    throwIfAborted(input.signal);
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
    const contentSha256 = input.contentSha256 ?? sha256Hex(bytes);
    throwIfAborted(input.signal);

    await reportStage(input.onStage, { stage: "extracting" }, input.signal);
    const content = await contentFor(type, input.name, bytes, input.logger, input.signal);
    throwIfAborted(input.signal);
    const inline = content.length <= input.config.FILE_INLINE_TOKENS * APPROX_CHARS_PER_TOKEN;
    const chunks = inline ? [] : type === "csv" ? chunkCsv(content) : chunkMarkdown(content);
    input.logger?.debug("file content extracted", {
      name: input.name,
      type,
      chars: content.length,
      inline,
      chunks: chunks.length,
    });
    await reportStage(input.onStage, {
      stage: "indexing",
      completed: inline ? 1 : 0,
      total: inline ? 1 : Math.max(1, chunks.length),
    }, input.signal);
    const file = await input.repo.insertFile({
      ...baseFileFields(input, bytes, contentSha256, type),
      contentMd: inline ? content : null,
      summary: firstLine(content),
      isInline: inline,
    });
    fileId = file.id;
    input.logger?.debug("file row inserted", { fileId: file.id, name: input.name, inline });
    if (!inline) {
      const outline = await indexDocumentChunks(input, file, chunks, chunkIds);
      throwIfAborted(input.signal);
      await input.repo.setOutline(file.id, outline);
      const card = cardForFile(
        { ...file, outline_json: JSON.stringify(outline) },
        chunks.map((chunk) => ({ idx: chunk.idx, heading_path: chunk.headingPath })),
        input.name,
      );
      return await finish(file, card, false, { chunks: chunks.length });
    }
    return await finish(file, cardForFile(file, [], input.name), true, { chars: content.length });
  } catch (err) {
    if (!completed) {
      if (isAbortError(err) || input.signal?.aborted) {
        input.logger?.info("file ingest cancelled", { name: input.name, type, fileId: fileId ?? null });
      } else {
        input.logger?.warn("file ingest failed; cleaning up", {
          name: input.name,
          type,
          fileId: fileId ?? null,
          err: String(err),
        });
      }
      await cleanup();
    }
    throw err;
  }
}

export async function refreshExtractedFileBytes(input: FileRefreshInput): Promise<FileRow> {
  const type = classifyFile(input.file.name, input.mime ?? input.file.mime_type ?? "");
  if (!type || type === "legacy-doc" || type !== input.file.type) {
    throw new Error(`File #${input.file.id} cannot be re-extracted as ${type ?? "unknown"}.`);
  }
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const contentSha256 = sha256Hex(bytes);
  if (type === "image") {
    return input.repo.updateExtraction(input.file.id, {
      contentSha256,
      mimeType: input.mime ?? input.file.mime_type,
      size: bytes.length,
      contentMd: null,
      summary: input.file.summary,
      outline: null,
      isInline: true,
      status: "ready",
    });
  }

  if (type === "pdf" || type === "docx") {
    return input.repo.updateExtraction(input.file.id, {
      contentSha256,
      mimeType: input.mime ?? input.file.mime_type,
      size: bytes.length,
      contentMd: null,
      summary: sandboxDocumentSummary(type),
      outline: null,
      isInline: false,
      status: "source_only",
    });
  }

  const content = await contentFor(type, input.file.name, bytes, input.logger, input.signal);
  throwIfAborted(input.signal);
  const inline = content.length <= input.config.FILE_INLINE_TOKENS * APPROX_CHARS_PER_TOKEN;
  const chunks = inline ? [] : type === "csv" ? chunkCsv(content) : chunkMarkdown(content);
  for (let index = 0; index < chunks.length; index += 1) {
    await reportStage(input.onStage, {
      stage: "indexing",
      completed: index + 1,
      total: chunks.length,
    }, input.signal);
  }
  throwIfAborted(input.signal);
  const refreshed = await input.repo.replaceDocumentExtraction(input.file.id, {
    contentSha256,
    mimeType: input.mime ?? input.file.mime_type,
    size: bytes.length,
    contentMd: inline ? content : null,
    summary: firstLine(content),
    isInline: inline,
    chunks: chunks.map((chunk) => ({
      idx: chunk.idx,
      headingPath: chunk.headingPath,
      content: chunk.content,
    })),
  });
  input.logger?.info("chat file extracted content refreshed", {
    fileId: refreshed.id,
    bytes: bytes.length,
    inline,
    chunks: chunks.length,
  });
  return refreshed;
}

function baseFileFields(
  input: FileIngestInput,
  bytes: Buffer,
  contentSha256: string,
  type: AcceptedFileType,
) {
  return {
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId ?? null,
    contentSha256,
    mimeType: input.mime ?? null,
    type,
    name: input.name,
    size: bytes.length,
  };
}

async function indexDocumentChunks(
  input: FileIngestInput,
  file: FileRow,
  chunks: Array<{ idx: number; headingPath: string | null; content: string }>,
  chunkIds: number[],
): Promise<Array<{ chunk_index: number; heading_path: string | null }>> {
  const outline: Array<{ chunk_index: number; heading_path: string | null }> = [];
  const totalIndexingSteps = Math.max(1, chunks.length);
  let completedIndexingSteps = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    throwIfAborted(input.signal);
    const inserted = await input.repo.insertChunk({ fileId: file.id, idx: chunk.idx, headingPath: chunk.headingPath, content: chunk.content });
    chunkIds.push(inserted.id);
    outline.push({ chunk_index: inserted.idx, heading_path: inserted.heading_path });
    completedIndexingSteps += 1;
    await reportStage(input.onStage, {
      stage: "indexing",
      completed: completedIndexingSteps,
      total: totalIndexingSteps,
    }, input.signal);
  }
  return outline;
}

export function cardForFile(
  file: FileRow,
  chunks: Pick<FileChunkRow, "idx" | "heading_path">[] = [],
  displayName = file.name,
): string {
  const marker = chatFileMarker(file.id);
  if (file.type === "image") return `${marker} [image #${file.id}: ${file.summary ?? displayName}]`;
  if (file.extraction_status === "source_only") {
    return `${marker} File #${file.id}: ${displayName} (${file.type}, sandbox source). Use materialize_chat_files, then ${file.type === "pdf" ? "PDF Inspector or render_pdf_pages" : "OfficeCLI"}.`;
  }
  if (file.is_inline) {
    return [
      `${marker} File #${file.id}: ${displayName} (${file.type}, inline).`,
      `<attachment id="${file.id}" name="${displayName}">`,
      file.content_md ?? "",
      "</attachment>",
    ].join("\n");
  }
  const outline = decodeOutline(file.outline_json) ?? chunks.map((chunk) => ({
    chunk_index: chunk.idx,
    heading_path: chunk.heading_path,
  }));
  return [
    `${marker} File #${file.id}: ${displayName} (${file.type}, ${chunks.length} chunks). ${file.summary ?? ""}`.trim(),
    outlinePreview(outline),
    "Use search_in_file or read_file_section.",
  ].filter(Boolean).join(" ");
}

async function contentFor(
  type: AcceptedFileType,
  name: string,
  bytes: Buffer,
  logger?: Logger,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (type === "txt") {
    logger?.debug("extracting text file content", { name, bytes: bytes.length });
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
  }
  if (type === "csv") {
    logger?.debug("extracting csv file content", { name, bytes: bytes.length });
    const raw = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const rows = parse(raw, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
    const columns = rows[0]?.join(", ") ?? "";
    logger?.debug("csv file content extracted", { name, rows: Math.max(0, rows.length - 1), columns: rows[0]?.length ?? 0 });
    return `columns: ${columns} · ${Math.max(0, rows.length - 1)} rows\n\n${raw}`;
  }
  throw new Error(`${type} content must be inspected in the sandbox`);
}

function sandboxDocumentSummary(type: "pdf" | "docx"): string {
  return type === "pdf"
    ? "Original PDF available for PDF Inspector or model vision in the sandbox."
    : "Original DOCX available for OfficeCLI in the sandbox.";
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
  return text.split("\n").find((line) => line.trim())?.trim().slice(0, FILE_SUMMARY_MAX_CHARS) ?? "";
}

function outlinePreview(outline: Array<{ chunk_index: number; heading_path: string | null }>): string {
  const headings = outline
    .map((entry) => entry.heading_path || `chunk ${entry.chunk_index}`)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, OUTLINE_PREVIEW_HEADINGS);
  return headings.length ? `Outline: ${headings.join(" | ")}.` : "";
}

export function decodeOutline(raw: string | null): Array<{ chunk_index: number; heading_path: string | null }> | null {
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
