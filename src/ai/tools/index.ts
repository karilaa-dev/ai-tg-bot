import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { tool, zodSchema, type Tool } from "ai";
import { Bash, ReadWriteFs } from "just-bash";
import { z } from "zod";
import { tavily, type TavilyExtractOptions } from "@tavily/core";
import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Repos } from "../../db/repos/index.js";
import type { FileRow, StoredFileType, ThreadRow, UserRow } from "../../db/types.js";
import type { Logger } from "../../logger.js";
import type { TextEmbedder } from "../../memory/embeddings.js";
import { embed } from "../provider.js";
import { hybridSearch, threadChainScope } from "../../memory/retrieval.js";
import { classifyFile, ingestFileBytes } from "../../files/ingest.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES } from "../../files/limits.js";
import { sha256Hex } from "../../files/hash.js";

export interface ToolBuildInput {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  logger?: Logger;
  embedder?: TextEmbedder;
  redownloadFile?: (file: FileRow) => Promise<Buffer>;
  createdFiles?: CreatedFileAttachment[];
  pendingCreatedFiles?: PendingCreatedFile[];
  imageGenerator?: BotImageGenerator;
}

export interface CreatedFileAttachment {
  fileId: number;
  type: StoredFileType;
  name: string;
  path: string;
  size: number;
  caption?: string | null;
  inline: boolean;
  card: string;
  delivery?: "document" | "photo";
  origin?: "created_file" | "generated_image";
}

export type PendingCreatedFile = Promise<{ attachment?: CreatedFileAttachment; revisedPrompt?: string | null; error?: string }>;
export type ImageGenerationMode = "auto" | "generate" | "edit";
type CreatedFileDeliveryPreference = "auto" | "photo" | "document";
const GENERATED_IMAGE_FINAL_TEXT_GUIDANCE =
  'Write one concise past-tense final sentence starting with "Done —" that says what you generated or changed. Do not mention imagegen, generate_image, or an image tool.';

export interface ImageGenerationReference {
  fileId: number;
  name: string;
  path: string;
  mimeType: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  quality: AppConfig["CODEX_IMAGE_QUALITY"];
  size: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  mode: ImageGenerationMode;
  references: ImageGenerationReference[];
}

export interface ImageGenerationResult {
  imageBase64: string;
  revisedPrompt?: string | null;
  status?: string | null;
  mediaType?: string | null;
}

export type BotImageGenerator = (input: ImageGenerationRequest) => Promise<ImageGenerationResult>;

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
  let generateImageQueued = false;
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
    generate_image: {
      description:
        'Generate or edit an image with the configured Codex app-server image model. The bot waits for generation to finish, then sends your final text followed by a separate captionless Telegram photo message. Use this when the user asks you to create, draw, render, generate, or edit an image. For edits or image references, pass current-thread image file ids in reference_file_ids. This tool is terminal: after a successful call, do not call more tools. Write one concise past-tense final sentence starting with "Done —" that says what you generated or changed, even for first-time image generation. Examples: "Done — I generated a pixel-styled Hatsune Miku." or "Done — I made her sitting and changed her hair to red." If you return empty text, the bot will send a generic ready message before the photo. Do not say the image is still generating, queued, or coming soon in your final text. Do not mention using imagegen, generate_image, or an image tool in final text; tool usage belongs in reasoning.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000),
        reference_file_ids: z.array(z.coerce.number().int().positive()).max(4).default([]),
        mode: z.enum(["auto", "generate", "edit"]).default("auto"),
        size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
        caption: z.string().max(1024).optional(),
      }),
      execute: async ({ prompt, reference_file_ids = [], mode = "auto", size = "1024x1024", caption }) => {
        try {
          if (!input.imageGenerator) throw new Error("image generator is unavailable");
          const usedBefore = input.createdFiles?.length ?? 0;
          if (usedBefore >= MAX_CREATED_FILES_PER_ANSWER) {
            throw new Error(
              `File limit reached: ${MAX_CREATED_FILES_PER_ANSWER} files are already attached to this answer. Do not try to attach more files in this answer.`,
            );
          }
          if (input.createdFiles?.some((file) => file.origin === "generated_image")) {
            throw new Error("an image has already been generated for this answer; finish the conversation with that image");
          }
          if (generateImageQueued) {
            throw new Error("an image is already being generated for this answer; finish the conversation with that image");
          }
          const promptText = prompt.trim();
          if (!promptText) throw new Error("prompt is empty");
          const references = await resolveImageGenerationReferences(input, reference_file_ids);
          if (mode === "edit" && !references.length) {
            throw new Error("mode edit requires at least one reference_file_id");
          }
          generateImageQueued = true;
          const generatedInput = {
            prompt: promptText,
            model: input.config.CODEX_IMAGE_MODEL,
            quality: input.config.CODEX_IMAGE_QUALITY,
            size,
            mode,
            references,
          };
          const createAttachment = () => createGeneratedImageAttachment(input, {
            promptText,
            generatedInput,
            caption,
            usedBefore,
          });
          if (input.pendingCreatedFiles) {
            const pending = createAttachment()
              .then((result) => {
                input.createdFiles?.push(result.attachment);
                return { attachment: result.attachment, revisedPrompt: result.revisedPrompt };
              })
              .catch((err) => {
                input.logger?.warn("tool generate_image failed", {
                  threadId: input.thread.id,
                  err: String(err),
                });
                return { error: String(err) };
              });
            input.pendingCreatedFiles.push(pending);
            input.logger?.info("tool generate_image queued", {
              threadId: input.thread.id,
              pendingFiles: input.pendingCreatedFiles.length,
              model: input.config.CODEX_IMAGE_MODEL,
              quality: input.config.CODEX_IMAGE_QUALITY,
              size,
            });
            return {
              status: `image generation started (${usedBefore + 1}/${MAX_CREATED_FILES_PER_ANSWER} files used)`,
              generated_image: true,
              terminal: true,
              pending: true,
              model: input.config.CODEX_IMAGE_MODEL,
              quality: input.config.CODEX_IMAGE_QUALITY,
              requested_size: size,
              mode,
              reference_file_ids,
              final_text_guidance: GENERATED_IMAGE_FINAL_TEXT_GUIDANCE,
            };
          }
          const result = await createAttachment()
            .then((result) => {
              input.createdFiles?.push(result.attachment);
              return { attachment: result.attachment, revisedPrompt: result.revisedPrompt };
            });
          const attachment = result.attachment;
          return {
            file_id: attachment.fileId,
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            caption: attachment.caption ?? null,
            status: `1 image generated (${usedBefore + 1}/${MAX_CREATED_FILES_PER_ANSWER} files used)`,
            generated_image: true,
            terminal: true,
            model: input.config.CODEX_IMAGE_MODEL,
            quality: input.config.CODEX_IMAGE_QUALITY,
            requested_size: size,
            mode,
            reference_file_ids,
            revised_prompt: result.revisedPrompt ?? null,
            final_text_guidance: GENERATED_IMAGE_FINAL_TEXT_GUIDANCE,
          };
        } catch (err) {
          input.logger?.warn("tool generate_image failed", {
            threadId: input.thread.id,
            err: String(err),
          });
          return { error: String(err) };
        }
      },
    },
    create_file: {
      description:
        "Queue a file that you created in this thread's bash workspace to send back to the Telegram user. First create the file with bash, then call this tool with its absolute virtual path. Attach at most 10 files per answer; do not call create_file more than 10 times in one answer. If more files are needed, send the first 10 and say the rest can be sent in another answer. Files up to 20 MB are allowed unless they are native/compiled executables such as exe, dll, ELF/Mach-O binaries, shared libraries, Java bytecode archives, or WebAssembly. Scripts and source files such as sh, bash, ps1, py, js, ts, and similar text/code files are allowed. Images are sent as Telegram photos by default; set delivery to document when exact bytes, transparency, metadata, print/source assets, or uncompressed delivery matters.",
      inputSchema: z.object({
        path: z.string().regex(/^\//, "path must be an absolute virtual path"),
        name: z.string().min(1).max(255).optional(),
        mime: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        delivery: z.enum(["auto", "photo", "document"]).default("auto"),
      }),
      execute: async ({ path: virtualPath, name, mime, caption, delivery = "auto" }) => {
        try {
          const usedBefore = input.createdFiles?.length ?? 0;
          if (usedBefore >= MAX_CREATED_FILES_PER_ANSWER) {
            throw new Error(
              `File limit reached: ${MAX_CREATED_FILES_PER_ANSWER} files are already attached to this answer. Do not try to attach more files in this answer.`,
            );
          }
          input.logger?.info("tool create_file starting", {
            threadId: input.thread.id,
            path: virtualPath,
            name: name ?? null,
            mime: mime ?? null,
          });
          const prepared = await prepareCreatedFile(input, { virtualPath, name, mime, caption, delivery });
          input.createdFiles?.push(prepared);
          const used = usedBefore + 1;
          input.logger?.info("tool create_file complete", {
            threadId: input.thread.id,
            fileId: prepared.fileId,
            name: prepared.name,
            type: prepared.type,
            bytes: prepared.size,
            filesUsed: used,
            filesLimit: MAX_CREATED_FILES_PER_ANSWER,
          });
          return {
            file_id: prepared.fileId,
            name: prepared.name,
            type: prepared.type,
            size: prepared.size,
            caption: prepared.caption ?? null,
            status: `1 file attached (${used}/${MAX_CREATED_FILES_PER_ANSWER} used)`,
            attached_files_used: used,
            attached_files_limit: MAX_CREATED_FILES_PER_ANSWER,
          };
        } catch (err) {
          input.logger?.warn("tool create_file failed", {
            threadId: input.thread.id,
            path: virtualPath,
            err: String(err),
          });
          return { error: String(err) };
        }
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

const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;

async function createGeneratedImageAttachment(
  input: ToolBuildInput,
  params: {
    promptText: string;
    generatedInput: ImageGenerationRequest;
    caption?: string;
    usedBefore: number;
  },
): Promise<{ attachment: CreatedFileAttachment; revisedPrompt: string | null }> {
  input.logger?.info("tool generate_image starting", {
    threadId: input.thread.id,
    promptChars: params.promptText.length,
    references: params.generatedInput.references.length,
    model: params.generatedInput.model,
    quality: params.generatedInput.quality,
    size: params.generatedInput.size,
  });
  if (!input.imageGenerator) throw new Error("image generator is unavailable");
  const generated = await input.imageGenerator(params.generatedInput);
  const hasInlineImageData = Boolean(generated.imageBase64?.trim());
  if (!hasInlineImageData) throw new Error("Codex image generation returned no base64 image data");
  const generatedBytes = generatedImageBytes(generated);
  const bytes = generatedBytes.bytes;
  if (!bytes.length) throw new Error("image generator returned empty image data");
  if (bytes.length > MAX_TELEGRAM_PHOTO_BYTES) {
    throw new Error(`generated image is too large to send as a Telegram photo (${formatBytes(bytes.length)})`);
  }
  const mediaType = normalizeGeneratedImageMediaType(generated.mediaType ?? generatedBytes.mediaType, bytes);
  const name = generatedImageName(mediaType);
  const revisedPrompt = generated.revisedPrompt?.trim() || null;
  const summary = revisedPrompt || params.promptText;
  const ingested = await ingestFileBytes({
    config: input.config,
    repo: input.repos.files,
    userId: input.user.tg_id,
    threadId: input.thread.id,
    bytes,
    name,
    mime: mediaType,
    imageSummary: summary,
    embeddings: input.repos.embeddings,
    embedder: input.embedder,
    logger: input.logger,
  });
  const stored = await input.repos.files.get(ingested.fileId);
  if (!stored) throw new Error(`generated image was not stored: ${ingested.fileId}`);
  const attachment: CreatedFileAttachment = {
    fileId: ingested.fileId,
    type: ingested.type,
    name: stored.name,
    path: stored.path,
    size: stored.size,
    caption: params.caption?.trim() || null,
    inline: ingested.inline,
    card: ingested.card,
    delivery: "photo",
    origin: "generated_image",
  };
  const used = params.usedBefore + 1;
  input.logger?.info("tool generate_image complete", {
    threadId: input.thread.id,
    fileId: attachment.fileId,
    bytes: attachment.size,
    references: params.generatedInput.references.length,
    filesUsed: used,
    filesLimit: MAX_CREATED_FILES_PER_ANSWER,
  });
  return { attachment, revisedPrompt };
}

async function resolveImageGenerationReferences(
  input: ToolBuildInput,
  fileIds: number[],
): Promise<ImageGenerationReference[]> {
  if (!fileIds.length) return [];
  const requestedIds = [...new Set(fileIds)];
  const scope = await threadChainScope(input.repos, input.thread);
  const scopedIds = new Set(scope.fileIds);
  const files = await input.repos.files.listByIds(requestedIds);
  const byId = new Map(files.map((file) => [file.id, file]));
  const references: ImageGenerationReference[] = [];
  for (const fileId of requestedIds) {
    const file = byId.get(fileId);
    if (!file || !scopedIds.has(file.id)) throw new Error(`reference image #${fileId} was not found in this thread`);
    if (file.type !== "image") throw new Error(`reference file #${fileId} is ${file.type}, not an image`);
    await readCachedOrRedownloadImage(input, { file_id: file.id, path: file.path });
    references.push({
      fileId: file.id,
      name: file.name,
      path: file.path,
      mimeType: referenceImageMediaType(file),
    });
  }
  return references;
}

function normalizeGeneratedImageMediaType(value: string | null | undefined, bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "image/jpeg" || normalized === "image/png" || normalized === "image/webp") return normalized;
  const detected = detectImageMediaType(bytes);
  return detected ?? "image/png";
}

function generatedImageBytes(generated: ImageGenerationResult): { bytes: Buffer; mediaType?: string | null } {
  const inline = generated.imageBase64?.trim();
  if (inline) {
    const dataUrl = inline.match(/^data:([^;,]+);base64,(.+)$/i);
    return {
      bytes: Buffer.from(dataUrl?.[2] ?? inline, "base64"),
      mediaType: dataUrl?.[1] ?? generated.mediaType,
    };
  }
  return { bytes: Buffer.alloc(0), mediaType: generated.mediaType };
}

function detectImageMediaType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function generatedImageName(mediaType: "image/png" | "image/jpeg" | "image/webp"): string {
  switch (mediaType) {
    case "image/jpeg":
      return "generated-image.jpg";
    case "image/webp":
      return "generated-image.webp";
    case "image/png":
      return "generated-image.png";
  }
}

function referenceImageMediaType(file: FileRow): string {
  const mediaType = imageMediaType(file.name);
  return mediaType === "image/*" ? imageMediaType(file.path) : mediaType;
}

async function prepareCreatedFile(
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
  if (stat.size > MAX_FILE_BYTES) throw new Error("file is larger than 20 MB");

  const bytes = await fs.readFile(realPath);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("file is larger than 20 MB");
  const displayName = normalizeCreatedFileName(file.name ?? path.posix.basename(virtualPath));
  assertAllowedOutboundFile(displayName, file.mime, bytes);

  const type = classifyFile(displayName, file.mime ?? "");
  const requestedDelivery = file.delivery ?? "auto";
  if (requestedDelivery === "photo" && type !== "image") {
    throw new Error(`delivery photo requires an image file: ${displayName}`);
  }
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
        path: stored.path,
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
    path: stored.path,
    size: stored.size,
    caption: file.caption?.trim() || null,
    inline: Boolean(stored.is_inline),
    card: `File #${stored.id}: ${stored.name} (${formatBytes(stored.size)}).`,
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
  if (preference === "photo" && type !== "image") {
    throw new Error(`delivery photo requires an image file: ${name}`);
  }
  if (preference === "photo" || (preference === "auto" && type === "image")) return "photo";
  return "document";
}

async function storeOtherCreatedFile(
  input: ToolBuildInput,
  file: { bytes: Buffer; name: string },
): Promise<FileRow> {
  const outDir = path.resolve("data/files");
  await fs.mkdir(outDir, { recursive: true });
  const ext = path.extname(file.name).toLowerCase();
  const dest = path.join(outDir, `${nanoid()}${ext}`);
  await fs.writeFile(dest, file.bytes);
  return input.repos.files.insertFile({
    userId: input.user.tg_id,
    threadId: input.thread.id,
    type: "other",
    contentSha256: sha256Hex(file.bytes),
    name: file.name,
    path: dest,
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

function formatBytes(bytes: number): string {
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
