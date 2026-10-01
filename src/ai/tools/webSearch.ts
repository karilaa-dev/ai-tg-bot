import { z } from "zod";
import { tavily } from "@tavily/core";
import { toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";
import { raceWithAbort } from "../../files/cancel.js";

export function createWebSearchTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Find current sources and reference pages using Codex hosted web search or Tavily. Codex returns a sourced answer and source URLs; Tavily returns source snippets. Set include_images for image discovery when Tavily is configured. Download chosen originals with Bash and inspect them before use; search descriptions are not visual verification or license evidence. Cite only sources returned by current-turn tools. For a known raw URL or API endpoint, use Bash with curl -fsSL.",
    inputSchema: z.object({
      query: z.string(),
      max_results: z.number().int().min(1).max(10).default(5),
      include_images: z.boolean().optional(),
    }),
    execute: async ({ query, max_results, include_images = false }, signal) => {
      try {
        signal?.throwIfAborted();
        const provider = input.config.WEB_SEARCH_PROVIDER;
        const useCodex = provider === "codex" || (provider === "auto" && input.codexWebSearch
          && !(include_images && input.config.TAVILY_API_KEY));
        if (useCodex) {
          try {
            if (!input.codexWebSearch) throw new Error("Codex web search requires Codex OAuth credentials.");
            const result = await input.codexWebSearch(query, max_results, signal);
            return { ...result, ...(include_images ? {
              images: [], warning: "Codex web search does not return image candidates. Configure Tavily for image discovery.",
            } : {}) };
          } catch (error) {
            signal?.throwIfAborted();
            if (provider === "codex" || !input.config.TAVILY_API_KEY) throw error;
            input.logger?.warn("Codex web search failed; trying Tavily", { error: String(error) });
          }
        }
        if (!input.config.TAVILY_API_KEY) throw new Error("Web search requires Codex OAuth credentials or TAVILY_API_KEY.");
        input.logger?.info("tool web_search starting", {
          maxResults: max_results,
          queryChars: query.length,
        });
        const client = tavily({ apiKey: input.config.TAVILY_API_KEY });
        const res = await raceWithAbort(client.search(query, {
          maxResults: max_results,
          searchDepth: "basic",
          includeAnswer: false,
          includeImages: include_images,
          includeImageDescriptions: include_images,
        }), signal);
        const results =
          res.results?.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
            published_date: "publishedDate" in r ? r.publishedDate : undefined,
          })) ?? [];
        input.logger?.info("tool web_search complete", {
          results: results.length,
        });
        return {
          results,
          ...(include_images
            ? {
                images: (res.images ?? [])
                  .slice(0, 10)
                  .map((image) => ({
                    url: image.url,
                    description: image.description?.slice(0, 1000) ?? null,
                  })),
              }
            : {}),
        };
      } catch (err) {
        signal?.throwIfAborted();
        return toToolError(input, "web_search", err, {
          queryChars: query.length,
        });
      }
    },
    usage: output => "usage" in output ? output.usage : undefined,
  });
}
