import path from "node:path";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, StoredFileType } from "../../db/types.js";
import { classifyFile, ingestFileBytes } from "../../files/ingest.js";
import { sha256Hex } from "../../files/hash.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES } from "../../files/limits.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { e2bFileSource } from "../../e2b/fileSource.js";
import { threadChainScope } from "../../memory/retrieval.js";
import { arrayField, asRecord, numberField, rawStringField as stringField, stringArrayField } from "../../util/records.js";
import {
  type CreatedFileAttachment,
  type CreatedFileDeliveryPreference,
  type ToolBuildInput,
} from "./types.js";

export function toToolError(
  input: ToolBuildInput,
  name: string,
  err: unknown,
  logFields: Record<string, unknown> = {},
): { error: string } {
  input.logger?.warn(`tool ${name} failed`, { ...logFields, err: String(err) });
  return { error: String(err) };
}

export function assertCreatedFileCapacity(input: ToolBuildInput): number {
  const usedBefore = input.createdFiles?.length ?? 0;
  if (usedBefore >= MAX_CREATED_FILES_PER_ANSWER) {
    throw new Error(
      `File limit reached: ${MAX_CREATED_FILES_PER_ANSWER} files are already attached to this answer. Do not try to attach more files in this answer.`,
    );
  }
  return usedBefore;
}

function assertPhotoDeliverable(type: string | null, name: string): void {
  if (type !== "image") {
    throw new Error(`delivery photo requires an image file: ${name}`);
  }
}

export async function getScopedFile(input: ToolBuildInput, fileId: number): Promise<FileRow | undefined> {
  const file = await input.repos.files.get(fileId);
  const scope = await threadChainScope(input.repos, input.thread);
  const isCurrentTurnAttachment = input.createdFiles?.some((attachment) => attachment.fileId === fileId) ?? false;
  if (!file || (!scope.fileIds.includes(file.id) && !isCurrentTurnAttachment)) return undefined;
  return file;
}

export async function prepareCreatedFile(
  input: ToolBuildInput,
  file: { virtualPath: string; name?: string; mime?: string; caption?: string; delivery?: CreatedFileDeliveryPreference },
  signal?: AbortSignal,
): Promise<CreatedFileAttachment> {
  const virtualPath = normalizeBashCwd(file.virtualPath);
  const exported = await exportSandboxFile(input, virtualPath, signal);
  const bytes = exported.bytes;
  const requestedName = file.name ?? path.posix.basename(virtualPath);
  assertAllowedOutboundFile(requestedName, file.mime, bytes);
  const displayName = normalizeCreatedFileName(requestedName);
  assertAllowedOutboundFile(displayName, file.mime, bytes);

  const classified = classifyFile(displayName, file.mime ?? "");
  const requestedDelivery = file.delivery ?? "auto";
  if (requestedDelivery === "photo") assertPhotoDeliverable(classified, displayName);
  if (classified && classified !== "legacy-doc") {
    let ingestedFile: {
      result: Awaited<ReturnType<typeof ingestFileBytes>>;
      stored: FileRow;
    } | undefined;
    try {
      const ingested = await ingestFileBytes({
        config: input.config,
        repo: input.repos.files,
        userId: input.user.tg_id,
        threadId: input.thread.id,
        bytes,
        name: displayName,
        mime: file.mime,
        logger: input.logger,
        signal,
      });
      const stored = await input.repos.files.get(ingested.fileId);
      if (!stored) throw new Error(`created file was not stored: ${ingested.fileId}`);
      ingestedFile = { result: ingested, stored };
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      input.logger?.warn("created file ingest failed; storing as generic attachment", {
        threadId: input.thread.id,
        name: displayName,
        type: classified,
        err: String(err),
      });
    }
    if (ingestedFile) {
      const { result: ingested, stored } = ingestedFile;
      // Source registration is intentionally outside the ingest fallback: a source
      // write failure must not insert a second generic row for already-ingested bytes.
      await rememberE2BFileSource(input, stored.id, exported, file.mime);
      return {
        fileId: stored.id,
        type: ingested.type,
        name: stored.name,
        mimeType: stored.mime_type,
        size: stored.size,
        caption: file.caption?.trim() || null,
        inline: ingested.inline,
        card: ingested.card,
        delivery: createdFileDeliveryFor(ingested.type, requestedDelivery, stored.name),
        origin: "created_file",
      };
    }
  }

  const stored = await storeOtherCreatedFile(input, {
    bytes,
    name: displayName,
    mime: file.mime,
    type: classified === "image" ? "image" : "other",
  });
  await rememberE2BFileSource(input, stored.id, exported, file.mime);
  return {
    fileId: stored.id,
    type: stored.type,
    name: displayName,
    mimeType: stored.mime_type,
    size: stored.size,
    caption: file.caption?.trim() || null,
    inline: Boolean(stored.is_inline),
    card: `${chatFileMarker(stored.id)} File #${stored.id}: ${displayName} (${formatBytes(stored.size)}).`,
    delivery: createdFileDeliveryFor(stored.type, requestedDelivery, displayName),
    origin: "created_file",
  };
}

export async function prepareDirectCreatedFile(
  input: ToolBuildInput,
  file: {
    bytes: Buffer;
    name: string;
    mime?: string;
    caption?: string;
    delivery?: CreatedFileDeliveryPreference;
    summary?: string;
  },
  signal?: AbortSignal,
): Promise<CreatedFileAttachment> {
  assertAllowedOutboundFile(file.name, file.mime, file.bytes);
  const displayName = normalizeCreatedFileName(file.name);
  assertAllowedOutboundFile(displayName, file.mime, file.bytes);
  const classified = classifyFile(displayName, file.mime ?? "");
  const requestedDelivery = file.delivery ?? "auto";
  if (requestedDelivery === "photo") assertPhotoDeliverable(classified, displayName);

  if (classified && classified !== "legacy-doc") {
    try {
      const ingested = await ingestFileBytes({
        config: input.config,
        repo: input.repos.files,
        userId: input.user.tg_id,
        threadId: input.thread.id,
        bytes: file.bytes,
        name: displayName,
        mime: file.mime,
        imageSummary: file.summary,
        logger: input.logger,
        signal,
      });
      const stored = await input.repos.files.get(ingested.fileId);
      if (!stored) throw new Error(`created file was not stored: ${ingested.fileId}`);
      input.selectContextFiles?.([stored.id]);
      return {
        fileId: stored.id,
        type: ingested.type,
        name: stored.name,
        mimeType: stored.mime_type,
        data: file.bytes,
        size: stored.size,
        caption: file.caption?.trim() || null,
        inline: ingested.inline,
        card: ingested.card,
        delivery: createdFileDeliveryFor(ingested.type, requestedDelivery, stored.name),
        origin: "created_file",
      };
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      input.logger?.warn("direct created file ingest failed; storing as generic attachment", {
        threadId: input.thread.id,
        name: displayName,
        type: classified,
        err: String(err),
      });
    }
  }

  const stored = await storeOtherCreatedFile(input, {
    bytes: file.bytes,
    name: displayName,
    mime: file.mime,
    type: classified === "image" ? "image" : "other",
  });
  input.selectContextFiles?.([stored.id]);
  return {
    fileId: stored.id,
    type: stored.type,
    name: displayName,
    mimeType: stored.mime_type,
    data: file.bytes,
    size: stored.size,
    caption: file.caption?.trim() || null,
    inline: Boolean(stored.is_inline),
    card: `${chatFileMarker(stored.id)} File #${stored.id}: ${displayName} (${formatBytes(stored.size)}).`,
    delivery: createdFileDeliveryFor(stored.type, requestedDelivery, displayName),
    origin: "created_file",
  };
}

async function exportSandboxFile(
  input: ToolBuildInput,
  virtualPath: string,
  signal?: AbortSignal,
) {
  if (!input.commandRuntime) throw new Error("E2B command runtime is unavailable.");
  return input.commandRuntime.readWorkspaceFile({
    userId: input.user.tg_id,
    threadId: input.thread.id,
    virtualPath,
    maxBytes: MAX_FILE_BYTES,
    preserveSource: true,
    signal,
  });
}

async function rememberE2BFileSource(
  input: ToolBuildInput,
  fileId: number,
  exported: {
    sandboxId: string;
    sourceCanonicalPath: string | null;
    size: number;
    contentSha256: string;
  },
  mimeType?: string,
): Promise<void> {
  if (!exported.sourceCanonicalPath) throw new Error("E2B export has no durable source path.");
  await input.repos.files.rememberSource(fileId, e2bFileSource(input.config, {
    fileId,
    sandboxId: exported.sandboxId,
    sourceCanonicalPath: exported.sourceCanonicalPath,
    size: exported.size,
    contentSha256: exported.contentSha256,
    userId: input.user.tg_id,
    threadId: input.thread.id,
    mimeType,
  }));
}

function createdFileDeliveryFor(
  type: StoredFileType,
  preference: CreatedFileDeliveryPreference,
  name: string,
): "document" | "photo" {
  if (preference === "document") return "document";
  if (preference === "photo") assertPhotoDeliverable(type, name);
  if (preference === "photo" || (preference === "auto" && type === "image")) return "photo";
  return "document";
}

async function storeOtherCreatedFile(
  input: ToolBuildInput,
  file: {
    bytes: Buffer;
    name: string;
    mime?: string;
    type?: "image" | "other";
  },
): Promise<FileRow> {
  const stored = await input.repos.files.insertFile({
    userId: input.user.tg_id,
    threadId: input.thread.id,
    type: file.type ?? "other",
    contentSha256: sha256Hex(file.bytes),
    mimeType: file.mime?.trim() || null,
    name: file.name,
    size: file.bytes.length,
    summary: `Outbound file ${file.name}`,
    isInline: false,
  });
  return stored;
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

export function normalizeBashCwd(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function bashModelHint(result: Record<string, unknown>, input?: unknown): string | undefined {
  const exitCode = numberField(result, "exit_code");
  const timedOut = result.timed_out === true;
  if (exitCode === 0 && !timedOut && !result.error) return undefined;
  const script = stringField(asRecord(input), "script") ?? "";
  const combined = [stringField(result, "error"), stringField(result, "stderr"), stringField(result, "stdout")]
    .filter(Boolean)
    .join("\n");
  if (timedOut) return "The E2B command timed out; retry with a smaller bounded command.";
  if (/E2B.*(?:not configured|unavailable)|command runtime is unavailable/i.test(combined)) {
    return "The E2B command runtime is unavailable. Continue with online-only tools when possible, or report that sandbox command execution is unavailable.";
  }
  if (/out of memory|oom|killed|exit code 137/i.test(combined)) {
    return "The configured sandbox may have run out of memory. Retry with a smaller input or a less memory-intensive command.";
  }
  if (/permission denied|read-only file system/i.test(combined) && /apt|sudo|npm.*-g|pip.*system/i.test(`${script}\n${combined}`)) {
    return "The configured sandbox user cannot modify that system location. Install packages into user-writable locations or use an image with the required system tools preinstalled.";
  }
  const missingCommand = commandNotFoundName(combined);
  if (missingCommand) {
    return `The command \`${missingCommand}\` was not found. Check its spelling or use an installed equivalent; do not retry the unchanged command.`;
  }
  if (exitCode === 127) {
    return "Exit status 127 commonly indicates a missing command. Inspect stderr to identify it, and do not retry the unchanged command or guess a package name without evidence.";
  }
  if (exitCode === 22 && (/\bcurl\b/.test(script) || /curl:|http\/?\d(?:\.\d)?\s+\d{3}|status(?: code)?\s*[:=]?\s*[45]\d\d/i.test(combined))) {
    return "curl exit status 22 means an HTTP response was treated as a failure. Inspect the status and bounded response body, use --location and --fail-with-body where appropriate, and retry only transient 429 or 5xx responses with bounded timeouts.";
  }
  if (exitCode === 1) {
    return "The command exited with status 1. Inspect the reported stderr and stdout, correct that specific validation or command failure, and do not retry unchanged.";
  }
  if (/could not resolve|name or service not known|failed to connect|connection (?:refused|timed out)|network is unreachable|no route to host|private|loopback|link-local|metadata/i.test(combined)) {
    return "The destination was unreachable. Verify its address, service state, routing, and task relevance before retrying.";
  }
  return undefined;
}

function commandNotFoundName(output: string): string | undefined {
  const patterns = [
    /^(?:\/bin\/)?bash:\s*(?:line\s+\d+:\s*)?([^:\s]+):\s*command not found\s*$/im,
    /^sh:\s*(?:line\s+\d+:\s*)?([^:\s]+):\s*not found\s*$/im,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function webExtractModelHint(input: unknown, output: Record<string, unknown>): string | undefined {
  const urls = stringArrayField(asRecord(input), "urls");
  const rawUrls = urls.filter(isRawDataUrl);
  if (!rawUrls.length) return undefined;
  const results = arrayField(output, "results") ?? [];
  const failedResults = arrayField(output, "failed_results") ?? arrayField(output, "failedResults") ?? [];
  const hasReadableContent = results.some((item) => {
    const content = stringField(asRecord(item), "content");
    return content !== undefined && content.trim().length > 0;
  });
  const hasRawFailure = failedResults.some((item) => isRawDataUrl(stringField(asRecord(item), "url") ?? ""));
  if (!hasReadableContent || hasRawFailure || output.error) {
    return `Use bash with curl -fsSL for this URL: ${rawUrls[0]}`;
  }
  return undefined;
}

function isRawDataUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const params = Array.from(url.searchParams.keys());
  if (host.startsWith("api.") || host.includes(".api.")) return true;
  if (path.includes("/api/") || /^\/v\d+(\/|$)/.test(path)) return true;
  if (/\.(json|csv|tsv|xml|toml|yaml|yml|ndjson|txt)$/i.test(path)) return true;
  if (url.search.length > 0 && params.length >= 2) return true;
  return false;
}

export async function enrichThreadHits(
  repos: Repos,
  fileIds: number[],
  hits: Array<{ kind: "message" | "chunk"; ref_id: number; snippet: string; score: number }>,
): Promise<unknown[]> {
  const chunks = fileIds.length ? await repos.files.chunksForFiles(fileIds) : [];
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return Promise.all(
    hits.map(async (hit) => {
      if (hit.kind === "message") {
        const message = await repos.messages.get(hit.ref_id);
        return {
          kind: "message",
          message_id: hit.ref_id,
          role: message?.role,
          date_iso: message ? new Date(message.created_at).toISOString() : undefined,
          snippet: hit.snippet,
          score: hit.score,
        };
      }
      if (hit.kind === "chunk") {
        const chunk = chunksById.get(hit.ref_id);
        return {
          kind: "chunk",
          chunk_id: hit.ref_id,
          chunk_index: chunk?.idx,
          heading_path: chunk?.heading_path,
          snippet: hit.snippet,
          score: hit.score,
        };
      }
      return undefined;
    }),
  ).then((items) => items.filter((item) => item !== undefined));
}

export function normalizeTavilyExtractResponse(value: unknown, maxCharsPerUrl: number): {
  results: Array<Record<string, unknown>>;
  failed_results: Array<Record<string, unknown>>;
  response_time?: number;
  request_id?: string;
} {
  const record = asRecord(value);
  const rawResults = arrayField(record, "results") ?? [];
  const rawFailed = arrayField(record, "failedResults") ?? arrayField(record, "failed_results") ?? [];
  return {
    results: rawResults.map((item) => normalizeTavilyExtractResult(item, maxCharsPerUrl)).filter(Boolean) as Array<Record<string, unknown>>,
    failed_results: rawFailed.map(normalizeTavilyExtractFailedResult).filter(Boolean) as Array<Record<string, unknown>>,
    response_time: numberField(record, "responseTime") ?? numberField(record, "response_time"),
    request_id: stringField(record, "requestId") ?? stringField(record, "request_id"),
  };
}

function normalizeTavilyExtractResult(value: unknown, maxCharsPerUrl: number): Record<string, unknown> | undefined {
  const record = asRecord(value);
  const url = stringField(record, "url");
  if (!url) return undefined;
  const rawContent = stringField(record, "rawContent") ?? stringField(record, "raw_content") ?? "";
  const result: Record<string, unknown> = {
    url,
    content: rawContent.slice(0, maxCharsPerUrl),
    truncated: rawContent.length > maxCharsPerUrl,
    chars: rawContent.length,
  };
  const images = stringArrayField(record, "images");
  if (images.length) result.images = images;
  const favicon = stringField(record, "favicon");
  if (favicon) result.favicon = favicon;
  return result;
}

function normalizeTavilyExtractFailedResult(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  const url = stringField(record, "url");
  if (!url) return undefined;
  return {
    url,
    error: stringField(record, "error") ?? "extraction failed",
  };
}
