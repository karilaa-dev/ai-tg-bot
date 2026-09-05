import path from "node:path";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow } from "../../db/types.js";
import { threadChainScope } from "../../memory/retrieval.js";
import { arrayField, asRecord, numberField, rawStringField as stringField, stringArrayField } from "../../util/records.js";
import { type ToolBuildInput } from "./types.js";

export function toToolError(
  input: ToolBuildInput,
  name: string,
  err: unknown,
  logFields: Record<string, unknown> = {},
): { error: string } {
  input.logger?.warn(`tool ${name} failed`, { ...logFields, err: String(err) });
  return { error: String(err) };
}

export async function getScopedFile(input: ToolBuildInput, fileId: number): Promise<FileRow | undefined> {
  const file = await input.repos.files.get(fileId);
  const scope = await (input.currentScope?.() ?? threadChainScope(input.repos, input.thread, input.maxMessageId));
  const isCurrentTurnAttachment = input.outgoingFiles?.items.some((attachment) => attachment.fileId === fileId) ?? false;
  if (!file || (!scope.fileIds.includes(file.id) && !isCurrentTurnAttachment)) return undefined;
  return file;
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
