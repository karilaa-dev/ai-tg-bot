import { z } from "zod";
import { tavily } from "@tavily/core";
import { toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createWebSearchTool(input: ToolBuildInput) {
  return defineBotTool({
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
        return toToolError(input, "web_search", err, { queryChars: query.length });
      }
    },
  });
}
