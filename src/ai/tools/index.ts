import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { tavily } from "@tavily/core";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, ThreadRow, UserRow } from "../../db/types.js";
import type { TextEmbedder } from "../../memory/embeddings.js";
import { embed } from "../provider.js";
import { hybridSearch, threadChainScope } from "../../memory/retrieval.js";

export function buildTools(input: {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  embedder?: TextEmbedder;
  redownloadFile?: (file: FileRow) => Promise<Buffer>;
}) {
  const embedder = input.embedder ?? {
    model: input.config.OPENROUTER_EMBEDDING_MODEL,
    embed: (texts: string[]) => embed(texts, input.config),
  };
  return {
    search_thread: tool({
      description: "Search this Telegram thread memory.",
      inputSchema: z.object({ query: z.string(), limit: z.number().max(20).default(8) }),
      execute: async ({ query, limit }) => {
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
        });
        return { results: await enrichThreadHits(input.repos, scope.fileIds, hits) };
      },
    }),
    load_message: tool({
      description: "Load one previous message by numeric id.",
      inputSchema: z.object({ message_id: z.number() }),
      execute: async ({ message_id }) => {
        const row = await input.repos.messages.get(message_id);
        const scope = await threadChainScope(input.repos, input.thread);
        if (!row || !scope.messageIds.includes(row.id)) return { error: "message not found in this thread" };
        const files = await input.repos.files.listForMessage(row.id);
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
    }),
    search_in_file: tool({
      description: "Search chunks of an attached large file.",
      inputSchema: z.object({
        file_id: z.number(),
        query: z.string(),
        limit: z.number().max(20).default(8),
      }),
      execute: async ({ file_id, query, limit }) => {
        const file = await input.repos.files.get(file_id);
        const scope = await threadChainScope(input.repos, input.thread);
        if (!file || !scope.fileIds.includes(file.id)) {
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
        });
        const chunks = await input.repos.files.chunks(file_id);
        const indexById = new Map(chunks.map((chunk) => [chunk.id, chunk.idx]));
        const headingById = new Map(chunks.map((chunk) => [chunk.id, chunk.heading_path]));
        return {
          results: hits
            .filter((hit) => hit.kind === "chunk")
            .map((hit) => ({
              chunk_id: hit.ref_id,
              chunk_index: indexById.get(hit.ref_id),
              heading_path: headingById.get(hit.ref_id),
              snippet: hit.snippet,
              score: hit.score,
            })),
        };
      },
    }),
    read_file_section: tool({
      description: "Read one or more chunks from an attached file.",
      inputSchema: z.object({
        file_id: z.number(),
        chunk_index: z.number(),
        count: z.number().max(8).default(1),
      }),
      execute: async ({ file_id, chunk_index, count }) => {
        const file = await input.repos.files.get(file_id);
        const scope = await threadChainScope(input.repos, input.thread);
        if (!file || !scope.fileIds.includes(file.id)) {
          return { error: "file not found in this thread" };
        }
        const chunks = await input.repos.files.chunks(file_id);
        if (chunk_index === -1) {
          return {
            outline: decodeOutline(file.outline_json) ??
              chunks.map((chunk) => ({
                chunk_index: chunk.idx,
                heading_path: chunk.heading_path,
              })),
          };
        }
        return {
          content: chunks
            .filter((chunk) => chunk.idx >= chunk_index && chunk.idx < chunk_index + count)
            .map((chunk) => `# chunk ${chunk.idx}${chunk.heading_path ? ` - ${chunk.heading_path}` : ""}\n${chunk.content}`)
            .join("\n\n"),
        };
      },
    }),
    web_search: tool({
      description: "Search the web for current information.",
      inputSchema: z.object({ query: z.string(), max_results: z.number().max(10).default(5) }),
      execute: async ({ query, max_results }) => {
        try {
          const client = tavily({ apiKey: input.config.TAVILY_API_KEY });
          const res = await client.search(query, {
            maxResults: max_results,
            searchDepth: "basic",
            includeAnswer: false,
          });
          return {
            results: res.results?.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.content,
              published_date: "publishedDate" in r ? r.publishedDate : undefined,
            })),
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}

async function readCachedOrRedownloadImage(
  input: {
    repos: Repos;
    redownloadFile?: (file: FileRow) => Promise<Buffer>;
  },
  image: { file_id: number; path: string },
): Promise<Buffer> {
  try {
    return await fs.readFile(image.path);
  } catch (err) {
    const file = await input.repos.files.get(image.file_id);
    if (!file || !input.redownloadFile) throw err;
    const bytes = await input.redownloadFile(file);
    await fs.mkdir(path.dirname(image.path), { recursive: true });
    await fs.writeFile(image.path, bytes);
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

function imageMediaType(name: string): string {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "image/*";
}
