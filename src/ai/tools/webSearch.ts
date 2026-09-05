import { z } from "zod";
import { tavily } from "@tavily/core";
import { toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createWebSearchTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Find current sources and reference pages. Set include_images to discover image URLs and descriptions for presentations or other visual work. Download chosen originals with Bash and inspect them before use; search descriptions are not visual verification or license evidence. Cite only sources returned by current-turn tools. For a known raw URL or API endpoint, use Bash with curl -fsSL.",
    inputSchema: z.object({
      query: z.string(),
      max_results: z.number().int().min(1).max(10).default(5),
      include_images: z.boolean().optional(),
    }),
    execute: async ({ query, max_results, include_images = false }) => {
      try {
        input.logger?.info("tool web_search starting", {
          maxResults: max_results,
          queryChars: query.length,
        });
        const client = tavily({ apiKey: input.config.TAVILY_API_KEY });
        const res = await client.search(query, {
          maxResults: max_results,
          searchDepth: "basic",
          includeAnswer: false,
          includeImages: include_images,
          includeImageDescriptions: include_images,
        });
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
        return toToolError(input, "web_search", err, {
          queryChars: query.length,
        });
      }
    },
  });
}
