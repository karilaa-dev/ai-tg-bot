import { z } from "zod";
import { asRecord } from "../../util/records.js";
import { normalizeTavilyExtractResponse, toToolError, webExtractModelHint } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS = 30;
const TAVILY_CLIENT_TIMEOUT_MARGIN_SECONDS = 5;

export function createWebExtractTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Perform one stateless Tavily extraction of readable content from known web page URLs. If the task needs screenshots, clicks, forms, login, downloads, scrolling, visual verification, or continued page actions, switch to the browser_* tools instead of chaining extraction as browser automation.",
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
        const trimmedQuery = query?.trim();
        const requestBody: Record<string, unknown> = {
          urls,
          extract_depth,
          format,
          include_images,
          include_favicon,
        };
        if (timeout !== undefined) requestBody.timeout = timeout;
        if (trimmedQuery) {
          requestBody.query = trimmedQuery;
          requestBody.chunks_per_source = chunks_per_source;
        }

        input.logger?.info("tool web_extract starting", {
          urls: urls.length,
          queryChars: trimmedQuery?.length ?? 0,
          extractDepth: extract_depth,
        });
        const requestTimeout = AbortSignal.timeout(
          (
            (timeout ?? DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS)
            + TAVILY_CLIENT_TIMEOUT_MARGIN_SECONDS
          ) * 1_000,
        );
        const requestSignal = signal
          ? AbortSignal.any([signal, requestTimeout])
          : requestTimeout;
        const response = await fetch(TAVILY_EXTRACT_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.config.TAVILY_API_KEY}`,
            "content-type": "application/json",
            "x-client-source": "ai-tg-bot",
          },
          body: JSON.stringify(requestBody),
          signal: requestSignal,
        });
        if (!response.ok) throw new Error(`Tavily extract failed with HTTP ${response.status}.`);
        const res: unknown = await response.json();
        const normalized = normalizeTavilyExtractResponse(res, max_chars_per_url);
        input.logger?.info("tool web_extract complete", {
          results: normalized.results.length,
          failedResults: normalized.failed_results.length,
        });
        return { provider: "tavily" as const, ...normalized };
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
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
