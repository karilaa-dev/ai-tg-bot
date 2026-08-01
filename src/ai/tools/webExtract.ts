import { z } from "zod";
import { tavily, type TavilyExtractOptions } from "@tavily/core";
import { createCamofoxClient } from "../../camofox/client.js";
import { disposableCamofoxUserId } from "../../camofox/session.js";
import { throwIfAborted } from "../../files/cancel.js";
import { asRecord } from "../../util/records.js";
import { normalizeTavilyExtractResponse, toToolError, webExtractModelHint } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const MAX_CAMOFOX_SNAPSHOT_PAGES = 20;

export function createWebExtractTool(input: ToolBuildInput) {
  return defineBotTool({
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
    }, signal) => {
      try {
        if (input.config.WEB_EXTRACT_PROVIDER === "camofox") {
          return await extractWithCamofox(input, {
            urls,
            includeImages: include_images,
            includeFavicon: include_favicon,
            maxCharsPerUrl: max_chars_per_url,
          }, signal);
        }
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
        return { provider: "tavily" as const, ...normalized };
      } catch (err) {
        return toToolError(input, "web_extract", err, { urls: urls.length });
      }
    },
    toModelOutput: ({ input, output }) => {
      const result = asRecord(output);
      if (!result) return { type: "json", value: output };
      const hint = webExtractModelHint(input, result);
      return { type: "json", value: hint ? { ...result, model_hint: hint } : result };
    },
  });
}

async function extractWithCamofox(
  input: ToolBuildInput,
  options: {
    urls: string[];
    includeImages: boolean;
    includeFavicon: boolean;
    maxCharsPerUrl: number;
  },
  signal?: AbortSignal,
) {
  const startedAt = Date.now();
  const client = createCamofoxClient(input.config);
  const userId = disposableCamofoxUserId(
    input.config,
    input.user.tg_id,
    input.thread.id,
    "extract",
  );
  const results: Array<Record<string, unknown>> = [];
  const failedResults: Array<Record<string, unknown>> = [];
  input.logger?.info("tool web_extract starting", {
    provider: "camofox",
    urls: options.urls.length,
  });
  try {
    for (const url of options.urls) {
      throwIfAborted(signal);
      let tabId: string | undefined;
      try {
        const tab = await client.createTab(userId, "web-extract", url, signal);
        tabId = tab.tabId;
        const loaded = await readCamofoxPage(client, userId, tabId, options.maxCharsPerUrl, signal);
        const result: Record<string, unknown> = {
          url: loaded.url || url,
          content: loaded.content,
          truncated: loaded.truncated,
          chars: loaded.totalChars,
        };
        if (options.includeImages) {
          const images = await client.images(userId, tabId, signal);
          const sources = [...new Set(images.map((image) => image.src).filter(Boolean))];
          if (sources.length) result.images = sources;
        }
        if (options.includeFavicon) {
          const evaluated = await client.evaluate(
            userId,
            tabId,
            "document.querySelector('link[rel~=icon]')?.href || null",
            signal,
          );
          if (typeof evaluated.result === "string" && evaluated.result) result.favicon = evaluated.result;
        }
        results.push(result);
      } catch (error) {
        throwIfAborted(signal);
        failedResults.push({ url, error: String(error) });
      } finally {
        if (tabId) {
          await client.closeTab(userId, tabId, cleanupSignal()).catch((error) => {
            input.logger?.warn("Camofox extraction tab cleanup failed", {
              threadId: input.thread.id,
              error: String(error),
            });
          });
        }
      }
    }
  } finally {
    await client.destroySession(userId, cleanupSignal()).catch((error) => {
      input.logger?.warn("Camofox extraction session cleanup failed", {
        threadId: input.thread.id,
        error: String(error),
      });
    });
  }
  input.logger?.info("tool web_extract complete", {
    provider: "camofox",
    results: results.length,
    failedResults: failedResults.length,
  });
  return {
    provider: "camofox" as const,
    results,
    failed_results: failedResults,
    response_time: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
  };
}

async function readCamofoxPage(
  client: ReturnType<typeof createCamofoxClient>,
  userId: string,
  tabId: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ url: string; content: string; truncated: boolean; totalChars: number }> {
  let offset = 0;
  let url = "";
  let content = "";
  let totalChars = 0;
  let hasMore = false;
  for (let pageIndex = 0; pageIndex < MAX_CAMOFOX_SNAPSHOT_PAGES && content.length < maxChars; pageIndex += 1) {
    throwIfAborted(signal);
    const snapshot = await client.snapshot(userId, tabId, { offset }, signal);
    url ||= snapshot.url;
    totalChars = Math.max(totalChars, snapshot.totalChars, offset + snapshot.snapshot.length);
    const remaining = maxChars - content.length;
    const previousLength = content.length;
    content += snapshot.snapshot.slice(0, remaining);
    hasMore = snapshot.hasMore || snapshot.snapshot.length > remaining;
    if (!snapshot.hasMore || snapshot.nextOffset === undefined || snapshot.nextOffset <= offset) break;
    if (content.length === previousLength) {
      hasMore = true;
      break;
    }
    offset = snapshot.nextOffset;
  }
  return {
    url,
    content,
    truncated: hasMore || totalChars > content.length,
    totalChars,
  };
}

function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}
