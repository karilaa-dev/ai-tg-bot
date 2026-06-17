import fs from "node:fs/promises";
import path from "node:path";
import { tool, zodSchema, type Tool } from "ai";
import { Bash, ReadWriteFs } from "just-bash";
import { z } from "zod";
import { tavily, type TavilyExtractOptions } from "@tavily/core";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../../db/types.js";
import type { Logger } from "../../logger.js";
import type { TextEmbedder } from "../../memory/embeddings.js";
import { embed } from "../provider.js";
import { hybridSearch, threadChainScope } from "../../memory/retrieval.js";

export interface ToolBuildInput {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  logger?: Logger;
  embedder?: TextEmbedder;
  redownloadFile?: (file: FileRow) => Promise<Buffer>;
}

export interface BotToolDefinition<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input) => Promise<Output>;
  toModelOutput?: (input: { toolCallId: string; input: Input; output: Output }) => unknown | Promise<unknown>;
}

export type BotToolRegistry = Record<string, BotToolDefinition<any, unknown>>;

export interface CodexDynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
  exposeToContext?: boolean;
}

export type CodexToolContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export function buildTools(input: ToolBuildInput): Record<string, Tool<any, unknown>> {
  return Object.fromEntries(
    Object.entries(buildToolRegistry(input)).map(([name, definition]) => [name, tool(definition as any) as Tool<any, unknown>]),
  );
}

export function buildToolRegistry(input: ToolBuildInput): BotToolRegistry {
  const embedder = input.embedder ?? {
    model: input.config.OPENROUTER_EMBEDDING_MODEL,
    embed: (texts: string[]) => embed(texts, input.config, input.logger),
  };
  return {
    search_thread: {
      description:
        "Search this Telegram thread memory and linked fork/compaction context. Use before claiming something was not discussed, when the user asks about prior chat details, or to find message ids for load_message.",
      inputSchema: z.object({ query: z.string(), limit: z.number().max(20).default(8) }),
      execute: async ({ query, limit }) => {
        input.logger?.debug("tool search_thread starting", {
          threadId: input.thread.id,
          limit,
          queryChars: query.length,
        });
        const scope = await threadChainScope(input.repos, input.thread);
        const hits = await hybridSearch({
          search: input.db.search,
          repos: input.repos,
          threadIds: scope.threadIds,
          messageIds: scope.messageIds,
          summaryIds: scope.summaryIds,
          fileIds: scope.fileIds,
          query,
          k: limit,
          embedder,
          embeddingModel: embedder.model,
          logger: input.logger,
        });
        const results = await enrichThreadHits(input.repos, scope.fileIds, hits);
        input.logger?.info("tool search_thread complete", {
          threadId: input.thread.id,
          results: results.length,
        });
        return { results };
      },
    },
    load_message: {
      description:
        "Load one previous message by numeric id from search_thread results or a user reference. Use when an exact earlier message, attached file metadata, or image context is needed.",
      inputSchema: z.object({ message_id: z.number() }),
      execute: async ({ message_id }) => {
        input.logger?.debug("tool load_message starting", { threadId: input.thread.id, messageId: message_id });
        const row = await input.repos.messages.get(message_id);
        const scope = await threadChainScope(input.repos, input.thread);
        if (!row || !scope.messageIds.includes(row.id)) {
          input.logger?.debug("tool load_message not found", { threadId: input.thread.id, messageId: message_id });
          return { error: "message not found in this thread" };
        }
        const files = await input.repos.files.listForMessage(row.id);
        input.logger?.info("tool load_message complete", {
          threadId: input.thread.id,
          messageId: row.id,
          files: files.length,
        });
        return {
          message_id: row.id,
          role: row.role,
          kind: row.kind,
          text: row.text_plain.slice(0, 8000),
          truncated: row.text_plain.length > 8000,
          files: files.map((file) => ({
            file_id: file.id,
            type: file.type,
            name: file.name,
            summary: file.summary,
            inline: Boolean(file.is_inline),
          })),
          images: files
            .filter((file) => file.type === "image")
            .map((file) => ({
              file_id: file.id,
              name: file.name,
              caption: file.summary,
              path: file.path,
              telegram_file_id: file.telegram_file_id,
              note: file.telegram_file_id
                ? "image bytes are cached locally and can be redownloaded from Telegram if missing"
                : "image bytes are available from the stored file path for reload",
            })),
        };
      },
      toModelOutput: async ({ output }: { toolCallId: string; input: unknown; output: unknown }) => {
        const result = output as {
          error?: string;
          message_id?: number;
          role?: string;
          kind?: string | null;
          text?: string;
          truncated?: boolean;
          files?: unknown[];
          images?: Array<{ file_id: number; name: string; caption?: string | null; path: string; telegram_file_id?: string | null }>;
        };
        if (result.error) return { type: "json", value: result as never };
        const imageParts = [];
        for (const image of result.images ?? []) {
          try {
            const data = await readCachedOrRedownloadImage(input, image);
            imageParts.push({ type: "image-data" as const, data: data.toString("base64"), mediaType: imageMediaType(image.name) });
          } catch (err) {
            input.logger?.warn("tool load_message image reload failed", {
              fileId: image.file_id,
              err: String(err),
            });
            imageParts.push({
              type: "text" as const,
              text: `[image #${image.file_id} could not be reloaded: ${String(err)}]`,
            });
          }
        }
        if (!imageParts.length) return { type: "json", value: result as never };
        return {
          type: "content",
          value: [
            {
              type: "text" as const,
              text: JSON.stringify({
                message_id: result.message_id,
                role: result.role,
                kind: result.kind,
                text: result.text,
                truncated: result.truncated,
                files: result.files,
                images: result.images?.map((image) => ({
                  file_id: image.file_id,
                  name: image.name,
                  caption: image.caption,
                })),
              }),
            },
            ...imageParts,
          ],
        } as never;
      },
    },
    search_in_file: {
      description:
        "Search chunks of an attached large file by file_id. Use before read_file_section when the user asks about a large uploaded document and the relevant chunk is unknown.",
      inputSchema: z.object({
        file_id: z.number(),
        query: z.string(),
        limit: z.number().max(20).default(8),
      }),
      execute: async ({ file_id, query, limit }) => {
        input.logger?.debug("tool search_in_file starting", {
          threadId: input.thread.id,
          fileId: file_id,
          limit,
          queryChars: query.length,
        });
        const file = await input.repos.files.get(file_id);
        const scope = await threadChainScope(input.repos, input.thread);
        if (!file || !scope.fileIds.includes(file.id)) {
          input.logger?.debug("tool search_in_file not found", { threadId: input.thread.id, fileId: file_id });
          return { error: "file not found in this thread" };
        }
        const hits = await hybridSearch({
          search: input.db.search,
          repos: input.repos,
          threadIds: [],
          messageIds: [],
          summaryIds: [],
          fileIds: [file_id],
          query,
          k: limit,
          embedder,
          embeddingModel: embedder.model,
          logger: input.logger,
        });
        const chunks = await input.repos.files.chunks(file_id);
        const indexById = new Map(chunks.map((chunk) => [chunk.id, chunk.idx]));
        const headingById = new Map(chunks.map((chunk) => [chunk.id, chunk.heading_path]));
        const results = hits
            .filter((hit) => hit.kind === "chunk")
            .map((hit) => ({
              chunk_id: hit.ref_id,
              chunk_index: indexById.get(hit.ref_id),
              heading_path: headingById.get(hit.ref_id),
              snippet: hit.snippet,
              score: hit.score,
            }));
        input.logger?.info("tool search_in_file complete", {
          threadId: input.thread.id,
          fileId: file_id,
          results: results.length,
        });
        return { results };
      },
    },
    read_file_section: {
      description:
        "Read one or more chunks from an attached file by file_id and chunk_index. Use after search_in_file identifies a chunk, or use chunk_index -1 to inspect the file outline.",
      inputSchema: z.object({
        file_id: z.number(),
        chunk_index: z.number(),
        count: z.number().max(8).default(1),
      }),
      execute: async ({ file_id, chunk_index, count }) => {
        input.logger?.debug("tool read_file_section starting", {
          threadId: input.thread.id,
          fileId: file_id,
          chunkIndex: chunk_index,
          count,
        });
        const file = await input.repos.files.get(file_id);
        const scope = await threadChainScope(input.repos, input.thread);
        if (!file || !scope.fileIds.includes(file.id)) {
          input.logger?.debug("tool read_file_section not found", { threadId: input.thread.id, fileId: file_id });
          return { error: "file not found in this thread" };
        }
        const chunks = await input.repos.files.chunks(file_id);
        if (chunk_index === -1) {
          const outline = decodeOutline(file.outline_json) ??
              chunks.map((chunk) => ({
                chunk_index: chunk.idx,
                heading_path: chunk.heading_path,
              }));
          input.logger?.info("tool read_file_section outline complete", {
            threadId: input.thread.id,
            fileId: file_id,
            headings: outline.length,
          });
          return { outline };
        }
        const content = chunks
            .filter((chunk) => chunk.idx >= chunk_index && chunk.idx < chunk_index + count)
            .map((chunk) => `# chunk ${chunk.idx}${chunk.heading_path ? ` - ${chunk.heading_path}` : ""}\n${chunk.content}`)
            .join("\n\n");
        input.logger?.info("tool read_file_section complete", {
          threadId: input.thread.id,
          fileId: file_id,
          chars: content.length,
        });
        return { content };
      },
    },
    bash: {
      description:
        "Run a bash script in this thread's persistent just-bash virtual workspace. The filesystem is isolated per Telegram thread. Use js-exec -c '...' for JavaScript, python3/python for local computation, and curl -fsSL for public raw URLs/APIs, optionally piped to jq. Do not use Python urllib/requests for web fetching; use curl for HTTPS/network data. If the user asks to search the internet/web/online or verify against online sources, include curl here or use web_search/web_extract before claiming online verification. For exact numeric verification, runtime comparisons, or constant-digit checks, prefer one simple bash call that computes all values, fetches any raw reference data, checks equality/lengths/counts, and emits compact JSON. Avoid command substitution $() and process substitution <(...); write js-exec/python3/curl outputs to temp files and compare/read those files. If part of a multi-step check fails, retry only the failed part and preserve already-successful values. Avoid node and unsupported shell setup such as set -o pipefail; node is only a help stub. Localhost/private network ranges are blocked.",
      inputSchema: z.object({
        script: z.string().min(1).max(20_000),
        cwd: z.string().regex(/^\//, "cwd must be an absolute virtual path").default("/"),
        stdin: z.string().max(100_000).default(""),
        args: z.array(z.string().max(4096)).max(32).default([]),
        raw_script: z.boolean().default(false),
      }),
      execute: async ({ script, cwd = "/", stdin = "", args = [], raw_script = false }) => {
        input.logger?.info("tool bash starting", {
          threadId: input.thread.id,
          scriptChars: script.length,
          stdinChars: stdin.length,
          args: args.length,
        });
        const result = await runBashTool(input, {
          script,
          cwd,
          stdin,
          args,
          rawScript: raw_script,
        });
        input.logger?.info("tool bash complete", {
          threadId: input.thread.id,
          exitCode: result.exit_code,
          timedOut: result.timed_out,
          stdoutChars: result.stdout.length,
          stderrChars: result.stderr.length,
          error: result.error,
        });
        return result;
      },
      toModelOutput: ({ input, output }) => {
        const result = asRecord(output);
        if (!result) return { type: "json", value: output };
        const hint = bashModelHint(result, input);
        return { type: "json", value: hint ? { ...result, model_hint: hint } : result };
      },
    },
    web_search: {
      description:
        "Search the web to discover candidate current sources and readable reference pages. Use when the user asks to search the internet/web/online and no successful curl result already verifies the answer. Do not claim or cite online verification from memory; cite only sources returned by current-turn web/curl tools. Use for finding sources, not for fetching known raw data. For a known public raw URL or API endpoint, prefer bash with curl -fsSL.",
      inputSchema: z.object({ query: z.string(), max_results: z.number().max(10).default(5) }),
      execute: async ({ query, max_results }) => {
        try {
          input.logger?.info("tool web_search starting", { maxResults: max_results, queryChars: query.length });
          const client = tavily({ apiKey: input.config.TAVILY_API_KEY });
          const res = await client.search(query, {
            maxResults: max_results,
            searchDepth: "basic",
            includeAnswer: false,
          });
          const results = res.results?.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.content,
              published_date: "publishedDate" in r ? r.publishedDate : undefined,
            })) ?? [];
          input.logger?.info("tool web_search complete", { results: results.length });
          return { results };
        } catch (err) {
          input.logger?.warn("tool web_search failed", { err: String(err), queryChars: query.length });
          return { error: String(err) };
        }
      },
    },
    web_extract: {
      description:
        "Extract readable article/page content from known web page URLs after discovery or when the URL is already known. Use current-turn extracted content before claiming a web page verifies an answer. Do not use for raw JSON/API endpoints, text data files, or exact raw-data/PDF verification; prefer bash with curl -fsSL for those.",
      inputSchema: z.object({
        urls: z.array(z.string().url()).min(1).max(5),
        query: z.string().optional(),
        chunks_per_source: z.number().int().min(1).max(5).default(3),
        extract_depth: z.enum(["basic", "advanced"]).default("basic"),
        format: z.enum(["markdown", "text"]).default("markdown"),
        include_images: z.boolean().default(false),
        include_favicon: z.boolean().default(false),
        timeout: z.number().min(1).max(60).optional(),
        max_chars_per_url: z.number().int().positive().max(20_000).default(12_000),
      }),
      execute: async ({
        urls,
        query,
        chunks_per_source,
        extract_depth,
        format,
        include_images,
        include_favicon,
        timeout,
        max_chars_per_url,
      }) => {
        try {
          const trimmedQuery = query?.trim();
          const options: TavilyExtractOptions = {
            extractDepth: extract_depth,
            format,
            includeImages: include_images,
            includeFavicon: include_favicon,
          };
          if (timeout !== undefined) options.timeout = timeout;
          if (trimmedQuery) {
            options.query = trimmedQuery;
            options.chunksPerSource = chunks_per_source;
          }

          input.logger?.info("tool web_extract starting", {
            urls: urls.length,
            queryChars: trimmedQuery?.length ?? 0,
            extractDepth: extract_depth,
          });
          const client = tavily({ apiKey: input.config.TAVILY_API_KEY });
          const res = await client.extract(urls, options);
          const normalized = normalizeTavilyExtractResponse(res, max_chars_per_url);
          input.logger?.info("tool web_extract complete", {
            results: normalized.results.length,
            failedResults: normalized.failed_results.length,
          });
          return normalized;
        } catch (err) {
          input.logger?.warn("tool web_extract failed", { err: String(err), urls: urls.length });
          return { error: String(err) };
        }
      },
      toModelOutput: ({ input, output }) => {
        const result = asRecord(output);
        if (!result) return { type: "json", value: output };
        const hint = webExtractModelHint(input, result);
        return { type: "json", value: hint ? { ...result, model_hint: hint } : result };
      },
    },
  };
}

export async function buildCodexToolSpecs(
  registry: BotToolRegistry,
  namespace = "telegram",
): Promise<CodexDynamicToolSpec[]> {
  return Promise.all(
    Object.entries(registry).map(async ([name, definition]) => ({
      namespace,
      name,
      description: definition.description,
      inputSchema: await zodSchema(definition.inputSchema).jsonSchema,
      exposeToContext: true,
    })),
  );
}

export async function executeBotTool(registry: BotToolRegistry, name: string, input: unknown): Promise<unknown> {
  const definition = registry[name];
  if (!definition) throw new Error(`unknown tool: ${name}`);
  const parsed = await definition.inputSchema.safeParseAsync(input);
  if (!parsed.success) throw new Error(`invalid ${name} input: ${parsed.error.message}`);
  return definition.execute(parsed.data);
}

export async function formatBotToolResultForCodex(
  registry: BotToolRegistry,
  name: string,
  input: unknown,
  output: unknown,
  toolCallId: string,
): Promise<CodexToolContentItem[]> {
  const definition = registry[name];
  if (definition?.toModelOutput) {
    try {
      const parsed = await definition.inputSchema.safeParseAsync(input);
      const modelOutput = await definition.toModelOutput({
        toolCallId,
        input: parsed.success ? parsed.data : input,
        output,
      });
      const converted = codexContentFromModelOutput(modelOutput);
      if (converted.length) return converted;
    } catch {
      return [{ type: "inputText", text: safeJson(output) }];
    }
  }
  return [{ type: "inputText", text: safeJson(output) }];
}

function codexContentFromModelOutput(modelOutput: unknown): CodexToolContentItem[] {
  const output = asRecord(modelOutput);
  if (!output) return [];
  if (output.type === "json" || output.type === "error-json") {
    return [{ type: "inputText", text: safeJson(output.value) }];
  }
  if (output.type === "text" || output.type === "error-text") {
    return [{ type: "inputText", text: String(output.value ?? "") }];
  }
  if (output.type !== "content" || !Array.isArray(output.value)) return [];
  const items: CodexToolContentItem[] = [];
  for (const part of output.value) {
    const record = asRecord(part);
    if (!record) continue;
    if (record.type === "text") {
      items.push({ type: "inputText", text: String(record.text ?? "") });
    } else if (record.type === "image-data" && typeof record.data === "string") {
      const mediaType = typeof record.mediaType === "string" ? record.mediaType : "image/*";
      items.push({ type: "inputImage", imageUrl: `data:${mediaType};base64,${record.data}` });
    } else {
      items.push({ type: "inputText", text: safeJson(record) });
    }
  }
  return items;
}

async function readCachedOrRedownloadImage(
  input: {
    repos: Repos;
    logger?: Logger;
    redownloadFile?: (file: FileRow) => Promise<Buffer>;
  },
  image: { file_id: number; path: string },
): Promise<Buffer> {
  try {
    return await fs.readFile(image.path);
  } catch (err) {
    input.logger?.debug("cached image missing; attempting Telegram redownload", {
      fileId: image.file_id,
      err: String(err),
    });
    const file = await input.repos.files.get(image.file_id);
    if (!file || !input.redownloadFile) throw err;
    const bytes = await input.redownloadFile(file);
    await fs.mkdir(path.dirname(image.path), { recursive: true });
    await fs.writeFile(image.path, bytes);
    input.logger?.info("cached image restored from Telegram", { fileId: image.file_id, bytes: bytes.length });
    return bytes;
  }
}

async function runBashTool(
  input: ToolBuildInput,
  command: {
    script: string;
    cwd: string;
    stdin: string;
    args: string[];
    rawScript: boolean;
  },
): Promise<{
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cwd: string;
  error?: string;
}> {
  const root = path.resolve(input.config.BASH_WORKSPACE_ROOT, `thread-${input.thread.id}`);
  await fs.mkdir(root, { recursive: true });
  const cwd = normalizeBashCwd(command.cwd);
  const bash = new Bash({
    fs: new ReadWriteFs({ root, allowSymlinks: false }),
    cwd: "/",
    env: { TZ: "UTC" },
    python: true,
    javascript: true,
    network: {
      dangerouslyAllowFullInternetAccess: true,
      denyPrivateRanges: true,
      timeoutMs: input.config.BASH_TIMEOUT_MS,
      maxResponseSize: 10 * 1024 * 1024,
    },
    defenseInDepth: true,
  });
  const controller = new AbortController();
  let timedOut = false;
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.config.BASH_TIMEOUT_MS);
  try {
    const result = await bash.exec(command.script, {
      args: command.args,
      cwd,
      env: { TZ: "UTC" },
      replaceEnv: true,
      rawScript: command.rawScript,
      signal: controller.signal,
      stdin: command.stdin,
    });
    const stdout = truncateBashOutput(result.stdout, input.config.BASH_MAX_OUTPUT_CHARS);
    const stderr = truncateBashOutput(result.stderr, input.config.BASH_MAX_OUTPUT_CHARS);
    const elapsedTimedOut = result.exitCode === 124 && Date.now() - startedAt >= input.config.BASH_TIMEOUT_MS;
    const didTimeOut = timedOut || elapsedTimedOut;
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exit_code: didTimeOut ? null : result.exitCode,
      timed_out: didTimeOut,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      cwd,
      ...(didTimeOut ? { error: `timed out after ${input.config.BASH_TIMEOUT_MS}ms` } : {}),
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: timedOut,
      stdout_truncated: false,
      stderr_truncated: false,
      cwd,
      error: timedOut ? `timed out after ${input.config.BASH_TIMEOUT_MS}ms` : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBashCwd(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function truncateBashOutput(value: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, maxChars);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

function bashModelHint(result: Record<string, unknown>, input?: unknown): string | undefined {
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

function webExtractModelHint(input: unknown, output: Record<string, unknown>): string | undefined {
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

async function enrichThreadHits(
  repos: Repos,
  fileIds: number[],
  hits: Array<{ kind: "message" | "summary" | "chunk"; ref_id: number; snippet: string; score: number }>,
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
      return { kind: "summary", summary_id: hit.ref_id, snippet: hit.snippet, score: hit.score };
    }),
  );
}

function decodeOutline(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTavilyExtractResponse(value: unknown, maxCharsPerUrl: number): {
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

function imageMediaType(name: string): string {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "image/*";
}

function arrayField(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | undefined, key: string): string[] {
  return (arrayField(record, key) ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
