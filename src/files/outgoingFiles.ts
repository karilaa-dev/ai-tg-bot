import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { CommandRuntime } from "../sandbox/types.js";
import { E2B_WORKSPACE, sandboxWorkspaceFile } from "../e2b/paths.js";
import { e2bFileSource } from "../e2b/fileSource.js";
import { classifyFile, ingestFileBytes } from "./ingest.js";
import { chatFileMarker } from "./contextMarker.js";
import { sha256Hex } from "./hash.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES, TG_PHOTO_MAX_BYTES } from "./limits.js";
import { OutgoingBuffers, prepareWithTwoWorkers } from "./outgoingBuffers.js";
import type { CreatedFileAttachment, CreatedFileDeliveryPreference } from "./types.js";

type FileOptions = { name?: string; mime?: string; caption?: string; delivery?: CreatedFileDeliveryPreference };
type DirectFile = FileOptions & { bytes: Buffer; name: string; summary?: string; origin?: "created_file" | "generated_image" };
type Input = {
  config: AppConfig;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  commandRuntime?: CommandRuntime;
  logger?: Logger;
  selectContextFiles?(ids: number[]): void;
};

/** Owns the attachment queue and every export reservation for one turn. */
export class OutgoingFiles {
  readonly buffers = new OutgoingBuffers();
  private readonly order: string[] = [];

  constructor(private readonly input: Input, readonly items: CreatedFileAttachment[] = []) {}

  async workspace(files: Array<FileOptions & { path: string }>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const paths = files.map((file) => normalizeCreatedFilePath(file.path));
    if (new Set(paths).size !== paths.length) throw new Error("File paths must be unique.");
    const existing = new Set(this.items.map((file) => file.sourceVirtualPath));
    this.assertCapacity(paths.filter((key) => !existing.has(key)).length);
    for (const key of [...this.items.map(fileKey), ...paths]) if (!this.order.includes(key)) this.order.push(key);
    const results = await prepareWithTwoWorkers(files, (file, index) => this.prepare(async () => {
      if (!this.input.commandRuntime) throw new Error("E2B command runtime is unavailable.");
      const exported = await this.input.commandRuntime.readWorkspaceFile({
        userId: this.input.user.tg_id, threadId: this.input.thread.id,
        virtualPath: paths[index]!, maxBytes: MAX_FILE_BYTES, preserveSource: true, signal,
      });
      return { file: { ...file, bytes: exported.bytes, name: file.name ?? path.posix.basename(paths[index]!) }, exported };
    }, signal));
    if (signal?.aborted) {
      await Promise.all(results.map((result) => result.status === "fulfilled" ? this.remove(result.value) : undefined));
      signal.throwIfAborted();
    }
    const prepared: Array<{ attachment: CreatedFileAttachment; replaced: boolean }> = [];
    const errors: Array<{ path: string; error: string }> = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === "rejected") { errors.push({ path: paths[index]!, error: String(result.reason) }); continue; }
      const attachment = result.value;
      attachment.sourceVirtualPath = paths[index];
      const oldIndex = this.items.findIndex((file) => file.sourceVirtualPath === paths[index]);
      const old = oldIndex < 0 ? undefined : this.items.splice(oldIndex, 1, attachment)[0];
      if (!old) this.items.push(attachment);
      else await this.remove(old);
      prepared.push({ attachment, replaced: Boolean(old) });
    }
    this.items.sort((a, b) => this.order.indexOf(fileKey(a)) - this.order.indexOf(fileKey(b)));
    return { prepared, errors };
  }

  async bytes(load: () => Promise<DirectFile>, signal?: AbortSignal): Promise<CreatedFileAttachment> {
    this.assertCapacity(1);
    const attachment = await this.prepare(async () => ({ file: await load() }), signal);
    this.items.push(attachment);
    this.order.push(fileKey(attachment));
    this.input.selectContextFiles?.([attachment.fileId]);
    return attachment;
  }

  dispose(): Promise<void> { return this.buffers.dispose(); }

  private assertCapacity(additional: number): void {
    if (this.items.length + additional > MAX_CREATED_FILES_PER_ANSWER) {
      throw new Error(`File limit reached: at most ${MAX_CREATED_FILES_PER_ANSWER} files per answer.`);
    }
  }

  private async prepare(load: () => Promise<{
    file: DirectFile;
    exported?: { sandboxId: string; sourceCanonicalPath: string | null; size: number; contentSha256: string };
  }>, signal?: AbortSignal): Promise<CreatedFileAttachment> {
    const startedAt = Date.now();
    const reservation = await this.buffers.reserve(MAX_FILE_BYTES, signal);
    let attachment: CreatedFileAttachment | undefined;
    try {
      const { file, exported } = await load();
      signal?.throwIfAborted();
      if (file.bytes.length > MAX_FILE_BYTES) throw new Error(file.origin === "generated_image" ? "Generated image exceeds the file delivery limit." : "File exceeds the configured size limit.");
      attachment = await this.store(file, signal);
      if (exported) {
        if (!exported.sourceCanonicalPath) throw new Error("E2B export has no durable source path.");
        await this.input.repos.files.rememberSource(attachment.fileId, e2bFileSource(this.input.config, {
          ...exported, sourceCanonicalPath: exported.sourceCanonicalPath, fileId: attachment.fileId,
          userId: this.input.user.tg_id, threadId: this.input.thread.id, mimeType: file.mime,
        }));
      } else await this.buffers.spool(attachment, file.bytes);
      signal?.throwIfAborted();
      reservation.commit(attachment, file.bytes);
      this.input.logger?.info("outgoing file prepared", {
        threadId: this.input.thread.id, fileId: attachment.fileId, bytes: attachment.size,
        preparationMs: Date.now() - startedAt, ...this.buffers.snapshot(),
      });
      return attachment;
    } catch (error) {
      if (attachment) await this.remove(attachment);
      throw error;
    } finally { reservation.release(); }
  }

  private async store(file: DirectFile, signal?: AbortSignal): Promise<CreatedFileAttachment> {
    assertAllowedOutboundFile(file.name, file.mime, file.bytes);
    const name = normalizeCreatedFileName(file.name);
    assertAllowedOutboundFile(name, file.mime, file.bytes);
    const type = classifyFile(name, file.mime ?? "");
    const preference = file.delivery ?? "auto";
    if ((preference === "photo" || preference === "photo_only") && type !== "image") throw new Error(`delivery photo requires an image file: ${name}`);
    if (preference === "photo_only" && file.bytes.length > TG_PHOTO_MAX_BYTES) throw new Error(`delivery photo_only requires an image no larger than ${TG_PHOTO_MAX_BYTES} bytes: ${name}`);
    let stored: FileRow | undefined;
    let card: string | undefined;
    if (type && type !== "legacy-doc" && file.origin !== "generated_image") {
      try {
        const ingested = await ingestFileBytes({
          config: this.input.config, repo: this.input.repos.files, userId: this.input.user.tg_id,
          threadId: this.input.thread.id, bytes: file.bytes, name, mime: file.mime,
          imageSummary: file.summary, logger: this.input.logger, signal,
        });
        stored = await this.input.repos.files.get(ingested.fileId);
        if (!stored) throw new Error(`created file was not stored: ${ingested.fileId}`);
        card = ingested.card;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        this.input.logger?.warn("created file ingest failed; storing as generic attachment", { threadId: this.input.thread.id, name, type, err: String(error) });
      }
    }
    stored ??= await this.input.repos.files.insertFile({
      userId: this.input.user.tg_id, threadId: this.input.thread.id,
      type: type === "image" ? "image" : "other", contentSha256: sha256Hex(file.bytes),
      mimeType: file.mime?.trim() || null, name, size: file.bytes.length,
      summary: file.origin === "generated_image" ? file.summary : `Outbound file ${name}`, isInline: false,
    });
    return {
      fileId: stored.id, type: stored.type, name: stored.name, mimeType: stored.mime_type, size: stored.size,
      caption: file.caption?.trim() || null, inline: Boolean(stored.is_inline),
      card: file.origin === "generated_image" ? `${chatFileMarker(stored.id)} [Generated image #${stored.id}: ${file.summary}]`
        : card ?? `${chatFileMarker(stored.id)} File #${stored.id}: ${name} (${formatBytes(stored.size)}).`,
      delivery: preference === "document" || stored.type !== "image" ? "document" : "photo",
      ...(preference === "photo_only" ? { photoFallback: "none" as const } : {}),
      origin: file.origin ?? "created_file",
    };
  }

  private async remove(attachment: CreatedFileAttachment): Promise<void> {
    this.buffers.release(attachment);
    await this.input.repos.files.deleteFile(attachment.fileId).catch((error) => {
      this.input.logger?.warn("failed to remove unqueued created file", { fileId: attachment.fileId, error: String(error) });
    });
  }
}

function fileKey(file: CreatedFileAttachment): string { return file.sourceVirtualPath ?? `#${file.fileId}`; }

function normalizeCreatedFilePath(value: string): string {
  const normalized = path.posix.normalize(value);
  return `/${path.posix.relative(E2B_WORKSPACE, sandboxWorkspaceFile(normalized.startsWith("/") ? normalized : `/${normalized}`))}`;
}
function assertAllowedOutboundFile(name: string, mime: string | undefined, bytes: Buffer): void {
  const ext = path.extname(name).toLowerCase();
  if (BLOCKED_EXECUTABLE_EXTENSIONS.has(ext)) throw new Error(`blocked executable file type: ${ext}`);
  const normalizedMime = mime?.toLowerCase().trim();
  if (normalizedMime && BLOCKED_EXECUTABLE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`blocked executable MIME type: ${normalizedMime}`);
  }
  const magic = executableMagic(bytes.subarray(0, 4).toString("hex"));
  if (magic) throw new Error(`blocked compiled executable: ${magic}`);
}

const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".com",
  ".scr",
  ".msi",
  ".msp",
  ".sys",
  ".drv",
  ".ocx",
  ".cpl",
  ".efi",
  ".so",
  ".dylib",
  ".bundle",
  ".node",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".class",
  ".jar",
  ".war",
  ".ear",
  ".apk",
  ".ipa",
  ".wasm",
]);

const BLOCKED_EXECUTABLE_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-msdos-program",
  "application/x-msi",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sharedlib",
  "application/java-archive",
  "application/x-java-applet",
  "application/wasm",
]);

function executableMagic(headHex: string): string | undefined {
  if (headHex === "7f454c46") {
    return "ELF binary";
  }
  if (headHex.startsWith("4d5a")) {
    return "Windows PE binary";
  }
  switch (headHex) {
    case "feedface":
    case "feedfacf":
    case "cefaedfe":
    case "cffaedfe":
      return "Mach-O binary";
    case "cafebabe":
    case "bebafeca":
      return "Mach-O universal binary or Java class";
    case "0061736d":
      return "WebAssembly binary";
    default:
      return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function normalizeCreatedFileName(value: string): string {
  const normalized = value.replace(/[\r\n\0]/g, " ").trim();
  const base = path.basename(normalized);
  if (!base || base === "." || base === "..") throw new Error("file name is empty");
  return Array.from(base).slice(0, 180).join("");
}
