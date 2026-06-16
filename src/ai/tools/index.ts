import fs from "node:fs/promises";
import path from "node:path";
import { tool, zodSchema, type Tool } from "ai";
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
      description: "Search this Telegram thread memory.",
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
      description: "Load one previous message by numeric id.",
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
      description: "Search chunks of an attached large file.",
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
      description: "Read one or more chunks from an attached file.",
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
    web_search: {
      description: "Search the web for current information.",
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
      description: "Extract readable content from one or more known web page URLs.",
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
