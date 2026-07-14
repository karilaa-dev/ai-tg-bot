import fs from "node:fs/promises";
import path from "node:path";
import type { FileRow } from "../db/types.js";
import { cardForFile, ingestFileBytes, type AcceptedFileType, type FileIngestProgress } from "../files/ingest.js";
import { sha256Hex } from "../files/hash.js";
import { detectImageMediaType } from "../files/mediaType.js";
import { isAbortError, throwIfAborted } from "../files/cancel.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { escapeHtml } from "../util/text.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback, threadExtra } from "./replies.js";
import { handleUserText } from "./turns.js";
import { enqueueMediaGroup } from "./batching.js";

interface TelegramFileInput {
  fileId: string;
  fileUniqueId?: string | null;
  name: string;
  mime?: string;
  caption?: string;
  type: AcceptedFileType;
  size?: number;
  mediaGroupId?: string;
}

interface PreparedTelegramFile {
  fileId: number;
  card: string;
  inline: boolean;
  type: AcceptedFileType;
}

export async function stopActiveFileProcessing(ctx: BotContext, quiet = false): Promise<boolean> {
  const key = activeFileJobKey(ctx);
  const job = key ? ctx.services.routerState.activeFileJobs.get(key) : undefined;
  if (!job) {
    ctx.services.logger.info("file stop requested with no active job", ctxLogMeta(ctx));
    if (!quiet) await replyWithThreadFallback(ctx, ctx.t("stop-none"), threadExtra(ctx.thread));
    return false;
  }
  ctx.services.logger.info("file stop requested", ctxLogMeta(ctx));
  await job.status.updateKey("file-processing-stopping");
  job.controller.abort();
  return true;
}

function activeFileJobKey(ctx: BotContext): string | undefined {
  if (!ctx.chat || !ctx.thread) return undefined;
  return `${ctx.chat.id}:${ctx.thread.topic_id ?? "general"}`;
}

export class FileProcessingStatus {
  private messageId?: number;
  private lastText = "";

  constructor(
    private readonly ctx: BotContext,
    private readonly name: string,
  ) {}

  updateIngestStage(progress: FileIngestProgress): Promise<void> {
    if (progress.stage === "extracting") return this.updateKey("file-processing-extracting");
    if (progress.stage === "embedding") return this.updateKey("file-processing-embedding", { percent: indexingPercent(progress) });
    return this.updateKey("file-processing-indexing", { percent: indexingPercent(progress) });
  }

  async updateKey(key: string, params: Record<string, string | number> = {}): Promise<void> {
    await this.updateText(this.ctx.t(key, { name: escapeHtml(this.name), ...params }));
  }

  async updateText(text: string): Promise<void> {
    if (text === this.lastText) return;
    if (!this.messageId) {
      try {
        const sent = await replyWithThreadFallback(this.ctx, text, {
          ...threadExtra(this.ctx.thread),
          parse_mode: "HTML",
        });
        this.messageId = sent.message_id;
        this.lastText = text;
      } catch (err) {
        this.ctx.services.logger.warn("failed to send file status message", { err: String(err), name: this.name });
      }
      return;
    }
    if (!this.ctx.chat) return;
    try {
      await this.ctx.api.editMessageText(this.ctx.chat.id, this.messageId, text, { parse_mode: "HTML" });
      this.lastText = text;
    } catch (err) {
      this.ctx.services.logger.warn("failed to edit file status message", { err: String(err), name: this.name });
    }
  }
}

function indexingPercent(progress: FileIngestProgress): number {
  if (!progress.total || progress.total <= 0) return 100;
  const completed = Math.max(0, Math.min(progress.completed ?? 0, progress.total));
  return Math.floor((completed / progress.total) * 100);
}

type IngestOutcome = "reused-cached" | "reused-hash" | "ingested";

type IngestTelegramResult =
  | { outcome: IngestOutcome; prepared: PreparedTelegramFile }
  | "too-big"
  | undefined;

async function ingestTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  opts: { signal: AbortSignal | undefined; status?: FileProcessingStatus; withEmbeddings: boolean; logLabel: "file" | "image" },
): Promise<IngestTelegramResult> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return undefined;
  const { signal, status, logLabel } = opts;
  const withType = logLabel === "file";
  const cached = input.fileUniqueId
    ? await ctx.services.repos.files.findByTelegramFileUniqueId(input.fileUniqueId)
    : undefined;
  if (cached) {
    ctx.services.logger.debug(withType ? "telegram file cache hit by unique id" : "image cache hit by unique id", ctxLogMeta(ctx, {
      fileId: cached.id,
      name: input.name,
      ...(withType ? { type: cached.type } : {}),
    }));
  }
  const reused = cached?.type === input.type
    ? await prepareCachedTelegramFile(ctx, input, cached, signal, status)
    : undefined;
  if (reused === "too-big") return "too-big";
  if (reused) return { outcome: "reused-cached", prepared: reused };

  await status?.updateKey("file-processing-downloading");
  ctx.services.logger.debug(withType ? "telegram file download starting" : "telegram image download starting", ctxLogMeta(ctx, {
    name: input.name,
    ...(withType ? { type: input.type } : {}),
  }));
  const downloaded = await ctx.services.downloadFile({
    api: ctx.api,
    config: ctx.services.config,
    fileId: input.fileId,
    signal,
  });
  throwIfAborted(signal);
  const bytes = Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
  ctx.services.logger.debug(withType ? "telegram file download complete" : "telegram image download complete", ctxLogMeta(ctx, {
    name: input.name,
    ...(withType ? { type: input.type } : {}),
    bytes: bytes.length,
  }));
  if ((input.size ?? bytes.length) > MAX_FILE_BYTES) {
    ctx.services.logger.warn(withType ? "downloaded file rejected; too large" : "downloaded image rejected; too large", ctxLogMeta(ctx, {
      name: input.name,
      ...(withType ? { type: input.type } : {}),
      bytes: bytes.length,
    }));
    if (status) await status.updateText(ctx.t("file-too-big"));
    else await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
    return "too-big";
  }
  const contentSha256 = sha256Hex(bytes);
  const cachedByHash = await ctx.services.repos.files.findByContentHash(contentSha256, {
    type: input.type,
    size: bytes.length,
  });
  if (cachedByHash) {
    ctx.services.logger.debug(withType ? "file cache hit by content hash" : "image cache hit by content hash", ctxLogMeta(ctx, {
      fileId: cachedByHash.id,
      name: input.name,
      ...(withType ? { type: cachedByHash.type } : {}),
    }));
    const hashReused = await prepareCachedTelegramFile(ctx, input, cachedByHash, signal, status, bytes);
    if (hashReused === "too-big") return "too-big";
    if (hashReused) return { outcome: "reused-hash", prepared: hashReused };
  }
  if (input.type === "image") {
    const mimeType = detectImageMediaType(bytes) ?? input.mime ?? "image/jpeg";
    const summary = await ctx.services.pi.captionImage(bytes, mimeType, input.caption);
    const file = await ctx.services.repos.files.insertFile({
      userId: ctx.user.tg_id,
      threadId: ctx.thread.id,
      type: "image",
      telegramFileId: input.fileId,
      telegramFileUniqueId: input.fileUniqueId ?? null,
      contentSha256,
      name: input.name,
      path: null,
      size: bytes.length,
      summary,
      isInline: true,
    });
    await ctx.services.repos.files.rememberTelegramFileRef(file.id, {
      fileUniqueId: input.fileUniqueId ?? null,
      telegramFileId: input.fileId,
    });
    return {
      outcome: "ingested",
      prepared: { fileId: file.id, card: cardForFile(file, [], input.name), inline: true, type: "image" },
    };
  }
  const ingested = await ingestFileBytes({
    config: ctx.services.config,
    repo: ctx.services.repos.files,
    userId: ctx.user.tg_id,
    threadId: ctx.thread.id,
    bytes,
    name: input.name,
    mime: input.mime,
    telegramFileId: input.fileId,
    telegramFileUniqueId: input.fileUniqueId ?? null,
    contentSha256,
    embeddings: opts.withEmbeddings ? ctx.services.repos.embeddings : undefined,
    embedder: opts.withEmbeddings ? ctx.services.embedder : undefined,
    logger: ctx.services.logger,
    signal,
    onStage: status ? (stage) => status.updateIngestStage(stage) : undefined,
  });
  throwIfAborted(signal);
  await ctx.services.repos.files.rememberTelegramFileRef(ingested.fileId, {
    fileUniqueId: input.fileUniqueId ?? null,
    telegramFileId: input.fileId,
  });
  return { outcome: "ingested", prepared: ingested };
}

export async function handleTelegramFile(ctx: BotContext, input: TelegramFileInput): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  if (input.type === "image") {
    await handleTelegramImage(ctx, input);
    return;
  }
  const activeFileJobs = ctx.services.routerState.activeFileJobs;
  const jobKey = activeFileJobKey(ctx);
  if (!jobKey) return;
  if (activeFileJobs.has(jobKey)) {
    ctx.services.logger.info("file job rejected; thread already processing", ctxLogMeta(ctx, {
      name: input.name,
      type: input.type,
    }));
    await replyWithThreadFallback(ctx, ctx.t("busy"), threadExtra(ctx.thread));
    return;
  }
  const controller = new AbortController();
  const status = new FileProcessingStatus(ctx, input.name);
  activeFileJobs.set(jobKey, { controller, status });
  const startedAt = Date.now();
  ctx.services.logger.info("file job starting", ctxLogMeta(ctx, {
    name: input.name,
    type: input.type,
    size: input.size ?? null,
    mediaGroupId: input.mediaGroupId ?? null,
  }));
  const clearJob = () => {
    const current = activeFileJobs.get(jobKey);
    if (current?.controller === controller) activeFileJobs.delete(jobKey);
  };
  try {
    const result = await ingestTelegramFile(ctx, input, {
      signal: controller.signal,
      status,
      withEmbeddings: true,
      logLabel: "file",
    });
    if (result === "too-big" || result === undefined) return;
    if (result.outcome !== "ingested") {
      await status.updateKey("file-reused");
      clearJob();
      ctx.services.logger.info(result.outcome === "reused-cached" ? "file job reused cached file" : "file job reused content hash", ctxLogMeta(ctx, {
        fileId: result.prepared.fileId,
        name: input.name,
        ms: Date.now() - startedAt,
      }));
      await handlePreparedTelegramFile(ctx, input, result.prepared);
      return;
    }
    await status.updateKey("file-processed");
    clearJob();
    ctx.services.logger.info("file job complete", ctxLogMeta(ctx, {
      fileId: result.prepared.fileId,
      name: input.name,
      type: input.type,
      inline: result.prepared.inline,
      ms: Date.now() - startedAt,
    }));
    await handlePreparedTelegramFile(ctx, input, result.prepared);
  } catch (err) {
    if (isAbortError(err) || controller.signal.aborted) {
      ctx.services.logger.info("file job cancelled", ctxLogMeta(ctx, { name: input.name, type: input.type }));
      await status.updateKey("file-processing-cancelled");
      return;
    }
    ctx.services.logger.warn("file ingestion failed", { err: String(err), name: input.name });
    const key = input.type === "pdf" || input.type === "docx" ? "docling-down" : "error-generic";
    await status.updateText(ctx.t(key));
  } finally {
    clearJob();
  }
}

async function handleTelegramImage(ctx: BotContext, input: TelegramFileInput): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  // image ingest is intentionally not /stop-able: media-group albums run one job per photo concurrently
  const startedAt = Date.now();
  ctx.services.logger.info("image ingest job starting", ctxLogMeta(ctx, {
    name: input.name,
    size: input.size ?? null,
    mediaGroupId: input.mediaGroupId ?? null,
  }));
  try {
    const result = await ingestTelegramFile(ctx, input, {
      signal: undefined,
      withEmbeddings: false,
      logLabel: "image",
    });
    if (result === "too-big" || result === undefined) return;
    if (result.outcome === "reused-cached") {
      ctx.services.logger.info("image ingest job reused cached image", ctxLogMeta(ctx, {
        fileId: result.prepared.fileId,
        name: input.name,
        ms: Date.now() - startedAt,
      }));
    } else if (result.outcome === "reused-hash") {
      ctx.services.logger.info("image ingest job reused content hash", ctxLogMeta(ctx, {
        fileId: result.prepared.fileId,
        name: input.name,
        ms: Date.now() - startedAt,
      }));
    } else {
      ctx.services.logger.info("image ingest job complete", ctxLogMeta(ctx, {
        fileId: result.prepared.fileId,
        name: input.name,
        ms: Date.now() - startedAt,
      }));
    }
    await handlePreparedTelegramFile(ctx, input, result.prepared);
  } catch (err) {
    if (isAbortError(err)) {
      ctx.services.logger.info("image ingest job cancelled", ctxLogMeta(ctx, { name: input.name }));
      return;
    }
    ctx.services.logger.warn("image ingest failed", { err: String(err), name: input.name });
    await replyWithThreadFallback(ctx, ctx.t("error-generic"), threadExtra(ctx.thread));
  }
}

async function prepareCachedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  cached: FileRow,
  signal: AbortSignal | undefined,
  status?: FileProcessingStatus,
  restoreBytes?: Buffer,
): Promise<PreparedTelegramFile | "too-big" | undefined> {
  if (cached.type !== "image" && (!cached.path || !(await fileExists(cached.path)))) {
    ctx.services.logger.warn("cached file missing on disk; restoring", ctxLogMeta(ctx, {
      fileId: cached.id,
      path: cached.path,
      name: input.name,
    }));
    let bytes = restoreBytes;
    if (!bytes) {
      await status?.updateKey("file-processing-downloading");
      const downloaded = await ctx.services.downloadFile({
        api: ctx.api,
        config: ctx.services.config,
        fileId: input.fileId,
        signal,
      });
      bytes = Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
    }
    throwIfAborted(signal);
    if ((input.size ?? bytes.length) > MAX_FILE_BYTES) {
      ctx.services.logger.warn("restored cached file rejected; too large", ctxLogMeta(ctx, {
        fileId: cached.id,
        bytes: bytes.length,
      }));
      if (status) await status.updateText(ctx.t("file-too-big"));
      else await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return "too-big";
    }
    if (!cached.path) throw new Error(`Cached file #${cached.id} has no storage path.`);
    await fs.mkdir(path.dirname(cached.path), { recursive: true });
    await fs.writeFile(cached.path, bytes);
    ctx.services.logger.info("cached file restored on disk", ctxLogMeta(ctx, {
      fileId: cached.id,
      bytes: bytes.length,
    }));
  }
  throwIfAborted(signal);
  await ctx.services.repos.files.rememberTelegramFileRef(cached.id, {
    fileUniqueId: input.fileUniqueId ?? null,
    telegramFileId: input.fileId,
  });
  const chunks = cached.is_inline ? [] : await ctx.services.repos.files.chunks(cached.id);
  ctx.services.logger.debug("prepared cached telegram file", ctxLogMeta(ctx, {
    fileId: cached.id,
    inline: Boolean(cached.is_inline),
    chunks: chunks.length,
  }));
  return {
    fileId: cached.id,
    card: cardForFile(cached, chunks, input.name),
    inline: Boolean(cached.is_inline),
    type: input.type,
  };
}

async function handlePreparedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  prepared: PreparedTelegramFile,
): Promise<void> {
  if (input.mediaGroupId) {
    ctx.services.logger.debug("prepared file queued for media group", ctxLogMeta(ctx, {
      groupId: input.mediaGroupId,
      fileId: prepared.fileId,
      type: prepared.type,
    }));
    enqueueMediaGroup(ctx, input.mediaGroupId, {
      caption: input.caption,
      card: prepared.card,
      file: { id: prepared.fileId, type: prepared.type, name: input.name, inline: prepared.inline },
    });
    return;
  }

  const kind = input.type === "image" ? "image" : "file";
  const text = [input.caption, prepared.card].filter((part) => part?.trim()).join("\n\n");
  ctx.services.logger.debug("dispatching prepared file as user turn", ctxLogMeta(ctx, {
    fileId: prepared.fileId,
    type: prepared.type,
    textChars: text.length,
  }));
  await handleUserText(ctx, text, {
    userMessageKind: kind,
    userMessageContent: {
      text,
      caption: input.caption ?? null,
      files: [{ id: prepared.fileId, type: prepared.type, name: input.name, inline: prepared.inline }],
    },
    onUserMessagePersisted: async (message) => {
      await ctx.services.repos.files.setMessageId(prepared.fileId, message.id, {
        displayName: input.name,
        caption: input.caption ?? null,
      });
    },
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
