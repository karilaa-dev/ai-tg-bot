import { z } from "zod";
import { tavily, type TavilyExtractOptions } from "@tavily/core";
import { asRecord } from "../../util/records.js";
import { normalizeTavilyExtractResponse, toToolError, webExtractModelHint } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

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
