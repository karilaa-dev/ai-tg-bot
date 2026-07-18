import fs from "node:fs/promises";
import path from "node:path";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, StoredFileType } from "../../db/types.js";
import type { Logger } from "../../logger.js";
import { classifyFile, ingestFileBytes } from "../../files/ingest.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES } from "../../files/limits.js";
import { sha256Hex } from "../../files/hash.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { threadChainScope } from "../../memory/retrieval.js";
import { arrayField, asRecord, numberField, rawStringField as stringField, stringArrayField } from "../../util/records.js";
import {
  MAX_FILE_MB,
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

export function assertPhotoDeliverable(type: string | null, name: string): void {
  if (type !== "image") {
    throw new Error(`delivery photo requires an image file: ${name}`);
  }
}

export async function getScopedFile(input: ToolBuildInput, fileId: number): Promise<FileRow | undefined> {
  const file = await input.repos.files.get(fileId);
  const scope = await threadChainScope(input.repos, input.thread);
  if (!file || !scope.fileIds.includes(file.id)) return undefined;
  return file;
}

export async function prepareCreatedFile(
  input: ToolBuildInput,
  file: { virtualPath: string; name?: string; mime?: string; caption?: string; delivery?: CreatedFileDeliveryPreference },
): Promise<CreatedFileAttachment> {
  const root = path.resolve(input.config.BASH_WORKSPACE_ROOT, `thread-${input.thread.id}`);
  await fs.mkdir(root, { recursive: true });
  const rootReal = await fs.realpath(root);
  const virtualPath = normalizeBashCwd(file.virtualPath);
  const hostPath = path.resolve(root, `.${virtualPath}`);
  const realPath = await fs.realpath(hostPath).catch(() => {
    throw new Error(`file not found: ${virtualPath}`);
  });
  if (!isPathInside(rootReal, realPath)) {
    throw new Error("file path escapes the thread workspace");
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error("path is not a regular file");
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_MB} MB`);

  const bytes = await fs.readFile(realPath);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_MB} MB`);
  const displayName = normalizeCreatedFileName(file.name ?? path.posix.basename(virtualPath));
  assertAllowedOutboundFile(displayName, file.mime, bytes);

  const type = classifyFile(displayName, file.mime ?? "");
  const requestedDelivery = file.delivery ?? "auto";
  if (requestedDelivery === "photo") assertPhotoDeliverable(type, displayName);
  if (type && type !== "legacy-doc") {
    try {
      const ingested = await ingestFileBytes({
        config: input.config,
        repo: input.repos.files,
        userId: input.user.tg_id,
        threadId: input.thread.id,
        bytes,
        name: displayName,
        mime: file.mime,
        embeddings: input.repos.embeddings,
        embedder: input.embedder,
        logger: input.logger,
      });
      const stored = await input.repos.files.get(ingested.fileId);
      if (!stored) throw new Error(`created file was not stored: ${ingested.fileId}`);
      const delivery = createdFileDeliveryFor(ingested.type, requestedDelivery, stored.name);
      return {
        fileId: ingested.fileId,
        type: ingested.type,
        name: stored.name,
        data: bytes,
        size: stored.size,
        caption: file.caption?.trim() || null,
        inline: ingested.inline,
        card: ingested.card,
        delivery,
        origin: "created_file",
      };
    } catch (err) {
      input.logger?.warn("created file ingest failed; storing as generic attachment", {
        threadId: input.thread.id,
        name: displayName,
        type,
        err: String(err),
      });
    }
  }

  const stored = await storeOtherCreatedFile(input, { bytes, name: displayName });
  const delivery = createdFileDeliveryFor(stored.type, requestedDelivery, stored.name);
  return {
    fileId: stored.id,
    type: stored.type,
    name: stored.name,
    data: bytes,
    size: stored.size,
    caption: file.caption?.trim() || null,
    inline: Boolean(stored.is_inline),
    card: `${chatFileMarker(stored.id)} File #${stored.id}: ${stored.name} (${formatBytes(stored.size)}).`,
    delivery,
    origin: "created_file",
  };
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
  file: { bytes: Buffer; name: string },
): Promise<FileRow> {
  return input.repos.files.insertFile({
    userId: input.user.tg_id,
    threadId: input.thread.id,
    type: "other",
    contentSha256: sha256Hex(file.bytes),
    name: file.name,
    path: null,
    size: file.bytes.length,
    summary: `Outbound file ${file.name}`,
    isInline: false,
  });
}

function assertAllowedOutboundFile(name: string, mime: string | undefined, bytes: Buffer): void {
  const ext = path.extname(name).toLowerCase();
  if (BLOCKED_EXECUTABLE_EXTENSIONS.has(ext)) throw new Error(`blocked executable file type: ${ext}`);
  const normalizedMime = mime?.toLowerCase().trim();
  if (normalizedMime && BLOCKED_EXECUTABLE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(`blocked executable MIME type: ${normalizedMime}`);
  }
  const magic = executableMagic(bytes);
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

function executableMagic(bytes: Buffer): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return "ELF binary";
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return "Windows PE binary";
  }
  const magic4 = bytes.length >= 4 ? bytes.subarray(0, 4).toString("hex") : "";
  switch (magic4) {
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function normalizeCreatedFileName(value: string): string {
  const normalized = value.replace(/[\r\n]/g, " ").trim();
  const base = path.basename(normalized);
  if (!base || base === "." || base === "..") throw new Error("file name is empty");
  return base;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeBashCwd(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function truncateBashOutput(value: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, maxChars);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

export function bashModelHint(result: Record<string, unknown>, input?: unknown): string | undefined {
  const exitCode = numberField(result, "exit_code");
  const timedOut = result.timed_out === true;
  if (exitCode === 0 && !timedOut && !result.error) return undefined;
  const script = stringField(asRecord(input), "script") ?? "";
  const combined = [stringField(result, "error"), stringField(result, "stderr"), stringField(result, "stdout")]
    .filter(Boolean)
    .join("\n");
  if (timedOut) return "The bash script timed out; retry with a smaller bounded command.";
  if (/\bnode\b/.test(script) || /this sandbox uses js-exec instead of node|node is .*stub/i.test(combined)) {
    return "Use js-exec -c '...' for JavaScript in just-bash; node is only a help stub.";
  }
  if (/\$\(|<\(/.test(script) || /command substitution|process substitution|syntax error near unexpected token|bad substitution/i.test(combined)) {
    return "Avoid just-bash command/process substitution. Write js-exec, python3, and curl outputs to temp files, then compare/read those files.";
  }
  if (/pipefail/i.test(script) || /pipefail/i.test(combined)) {
    return "Retry with a simpler just-bash script without set -o pipefail; emit compact JSON with the values and checks.";
  }
  if (/\bcurl\b/.test(script) || /networkaccessdenied|private\/loopback|localhost|curl:|failed to fetch|could not resolve|response.*too large/i.test(combined)) {
    return "Use curl for public internet URLs and raw APIs; localhost/private ranges are blocked. Use web_search for discovery and web_extract for readable pages.";
  }
  if (/security violation|dynamic import/i.test(combined)) {
    return "Retry with simpler just-bash syntax; some defense-in-depth paths reject dynamic imports.";
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
