import type { FileRow } from "../db/types.js";
import { isAbortError, throwIfAborted } from "../files/cancel.js";
import { sha256Hex } from "../files/hash.js";
import { cardForFile, ingestFileBytes, sourceFileSummary, type AcceptedFileType, type FileIngestProgress } from "../files/ingest.js";
import { audioFormat, EmptyTranscriptError, transcribeAudio } from "../audio/transcription.js";
import { chatFileMarker } from "../files/contextMarker.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { detectImageMediaType } from "../files/mediaType.js";
import { telegramFileSource } from "../files/telegramSource.js";
import { escapeHtml } from "../util/text.js";
import { enqueueMediaGroup, holdPendingMediaGroup } from "./batching.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback, threadExtra } from "./replies.js";
import { handleUserText } from "./turns.js";

interface TelegramFileInput {
  fileId: string;
  fileUniqueId?: string | null;
  name: string;
  mime?: string;
  caption?: string;
  type: AcceptedFileType;
  mediaKind: "document" | "photo" | "voice" | "audio";
  size?: number;
  mediaGroupId?: string;
  telegramRefs?: Array<{
    fileId: string;
    fileUniqueId?: string | null;
    width?: number | null;
    height?: number | null;
    size?: number | null;
    primary: boolean;
  }>;
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
    return this.updateKey("file-processing-indexing", { percent: indexingPercent(progress) });
  }

  async updateKey(key: string, params: Record<string, string | number> = {}): Promise<void> {
    await this.updateText(this.ctx.t(key, { name: escapeHtml(this.name), ...params }));
  }

  async clear(): Promise<void> {
    if (!this.messageId || !this.ctx.chat) return;
    try {
      await this.ctx.api.deleteMessage(this.ctx.chat.id, this.messageId);
      this.messageId = undefined;
      this.lastText = "";
    } catch (err) {
      this.ctx.services.logger.warn("failed to delete file status message", { err: String(err), name: this.name });
    }
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
  opts: {
    signal: AbortSignal | undefined;
    status?: FileProcessingStatus;
    logLabel: "file" | "image";
  },
): Promise<IngestTelegramResult> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return undefined;
  const { signal, status, logLabel } = opts;
  const withType = logLabel === "file";
  const source = telegramFileSource({ fileId: input.fileId, fileUniqueId: input.fileUniqueId, mimeType: input.mime });
  const cached = await ctx.services.repos.files.findBySource(source);
  if (cached) {
    ctx.services.logger.debug(withType ? "telegram file cache hit by unique id" : "image cache hit by unique id", ctxLogMeta(ctx, {
      fileId: cached.id,
      name: input.name,
      ...(withType ? { type: cached.type } : {}),
    }));
  }
  const reused = cached && isCompatibleStoredFile(cached, input)
    ? await prepareCachedTelegramFile(ctx, input, cached, signal, status)
    : undefined;
  if (reused) return { outcome: "reused-cached", prepared: reused };

  if (input.type === "pdf" || input.type === "docx" || input.type === "audio") {
    throwIfAborted(signal);
    if ((input.size ?? 0) > MAX_FILE_BYTES) {
      if (status) await status.updateText(ctx.t("file-too-big"));
      else await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return "too-big";
    }
    const file = await ctx.services.repos.files.insertFile({
      userId: ctx.user.tg_id,
      threadId: ctx.thread.id,
      type: input.type,
      mimeType: input.mime ?? null,
      extractionStatus: "source_only",
      name: input.name,
      size: input.size ?? 0,
      summary: sourceFileSummary(input.type),
      isInline: false,
    });
    const canonical = await claimTelegramSource(ctx, file, source, input);
    return {
      outcome: "ingested",
      prepared: await preparedTelegramFile(ctx, input, canonical),
    };
  }

  await status?.updateKey("file-processing-downloading");
  ctx.services.logger.debug(withType ? "telegram file download starting" : "telegram image download starting", ctxLogMeta(ctx, {
    name: input.name,
    ...(withType ? { type: input.type } : {}),
  }));
  const downloaded = await ctx.services.fileResolver.resolveSource(source, signal);
  throwIfAborted(signal);
  const bytes = Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
  ctx.services.logger.debug(withType ? "telegram file download complete" : "telegram image download complete", ctxLogMeta(ctx, {
    name: input.name,
    ...(withType ? { type: input.type } : {}),
    bytes: bytes.length,
  }));
  if ((input.size ?? bytes.length) > MAX_FILE_BYTES || bytes.length > MAX_FILE_BYTES) {
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
    const hashReused = await prepareCachedTelegramFile(ctx, input, cachedByHash, signal, status);
    if (hashReused) return { outcome: "reused-hash", prepared: hashReused };
  }
  if (input.type === "image") {
    const mimeType = detectImageMediaType(bytes) ?? input.mime ?? "image/jpeg";
    const summary = await ctx.services.pi.captionImage(bytes, mimeType, input.caption);
    const file = await ctx.services.repos.files.insertFile({
      userId: ctx.user.tg_id,
      threadId: ctx.thread.id,
      type: "image",
      contentSha256,
      mimeType,
      name: input.name,
      size: bytes.length,
      summary,
      isInline: true,
    });
    const canonical = await claimTelegramSource(ctx, file, { ...source, mimeType }, input);
    return {
      outcome: "ingested",
      prepared: await preparedTelegramFile(ctx, input, canonical),
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
    contentSha256,
    logger: ctx.services.logger,
    signal,
    onStage: status ? (stage) => status.updateIngestStage(stage) : undefined,
  });
  throwIfAborted(signal);
  const stored = await ctx.services.repos.files.get(ingested.fileId);
  if (!stored) throw new Error(`Ingested file #${ingested.fileId} disappeared before source registration.`);
  const canonical = await claimTelegramSource(ctx, stored, source, input);
  return {
    outcome: "ingested",
    prepared: canonical.id === ingested.fileId ? ingested : await preparedTelegramFile(ctx, input, canonical),
  };
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
  const releaseMediaGroup = holdPendingMediaGroup(ctx, input.mediaGroupId);
  try {
    const result = await ingestTelegramFile(ctx, input, {
      signal: controller.signal,
      status,
      logLabel: "file",
    });
    if (result === "too-big" || result === undefined) return;
    if (input.mediaKind === "voice" || input.mediaKind === "audio") {
      const format = audioFormat(input.name, input.mime);
      if (!format) throw new Error("Unsupported audio format.");
      await status.updateKey("file-processing-downloading");
      const downloaded = await ctx.services.fileResolver.resolveSource(telegramFileSource({
        fileId: input.fileId, fileUniqueId: input.fileUniqueId, mimeType: input.mime,
      }), controller.signal);
      await status.updateKey("audio-transcribing");
      const transcript = await transcribeAudio(ctx.services.config, {
        bytes: downloaded.bytes, format, signal: controller.signal,
      });
      throwIfAborted(controller.signal);
      result.prepared.card = `${transcript.text}\n\n${chatFileMarker(result.prepared.fileId)} [Audio message transcribed above]`;
      await status.clear();
      throwIfAborted(controller.signal);
      clearJob();
      await handlePreparedTelegramFile(ctx, input, result.prepared);
      return;
    }
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
    await status.updateKey(result.prepared.type === "pdf" || result.prepared.type === "docx" || result.prepared.type === "audio"
      ? "file-source-registered"
      : "file-processed");
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
    await status.updateText(ctx.t(err instanceof EmptyTranscriptError
      ? "audio-no-speech"
      : input.mediaKind === "voice" || input.mediaKind === "audio" ? "audio-transcription-failed" : "error-generic"));
  } finally {
    clearJob();
    releaseMediaGroup();
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
  _status?: FileProcessingStatus,
): Promise<PreparedTelegramFile> {
  throwIfAborted(signal);
  const canonical = await claimTelegramSource(ctx, cached, telegramFileSource({
    fileId: input.fileId,
    fileUniqueId: input.fileUniqueId,
    mimeType: input.mime,
  }), input);
  assertCompatibleTelegramFile(canonical, input);
  const prepared = await preparedTelegramFile(ctx, input, canonical);
  ctx.services.logger.debug("prepared indexed telegram file", ctxLogMeta(ctx, {
    fileId: canonical.id,
    inline: prepared.inline,
  }));
  return prepared;
}

async function claimTelegramSource(
  ctx: BotContext,
  candidate: FileRow,
  source: ReturnType<typeof telegramFileSource>,
  input: TelegramFileInput,
): Promise<FileRow> {
  const refs = input.telegramRefs?.length
    ? input.telegramRefs
    : [{
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      size: input.size,
      primary: true,
    }];
  const observation = await ctx.services.repos.files.rememberTelegramObservation(candidate.id, source, {
    direction: "inbound",
    mediaKind: input.mediaKind,
    telegramMessageId: ctx.message?.message_id ?? null,
    refs,
  });
  const canonical = await ctx.services.repos.files.get(observation.source.file_id);
  if (!canonical) throw new Error(`Canonical file #${observation.source.file_id} is missing.`);
  if (canonical.id === candidate.id) return canonical;
  if (!isCompatibleStoredFile(canonical, input)) {
    throw new Error(`Telegram source already belongs to incompatible file #${canonical.id}.`);
  }
  await ctx.services.repos.files.deleteFile(candidate.id);
  ctx.services.logger.info("reused canonical Telegram source owner", ctxLogMeta(ctx, {
    duplicateFileId: candidate.id,
    canonicalFileId: canonical.id,
  }));
  return canonical;
}

async function preparedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  file: FileRow,
): Promise<PreparedTelegramFile> {
  assertCompatibleTelegramFile(file, input);
  const chunks = file.is_inline ? [] : await ctx.services.repos.files.chunks(file.id);
  return {
    fileId: file.id,
    card: cardForFile(file, chunks, input.name),
    inline: Boolean(file.is_inline),
    type: input.type,
  };
}

function assertCompatibleTelegramFile(file: FileRow, input: TelegramFileInput): void {
  if (!isCompatibleStoredFile(file, input)) {
    throw new Error(`Telegram source resolves to incompatible file #${file.id}.`);
  }
}

function isCompatibleStoredFile(file: FileRow, input: TelegramFileInput): boolean {
  if (file.type !== input.type) return false;
  if (input.type === "pdf" || input.type === "docx" || input.type === "audio") {
    return file.extraction_status === "source_only" || file.extraction_status === "ready";
  }
  return file.extraction_status === "ready";
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
    attachments: [{
      fileId: prepared.fileId,
      displayName: input.name,
      caption: input.caption ?? null,
      telegramMessageId: ctx.message?.message_id ?? null,
    }],
  });
}
