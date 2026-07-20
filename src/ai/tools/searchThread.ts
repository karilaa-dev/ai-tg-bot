import { z } from "zod";
import type { TextEmbedder } from "../../memory/embeddings.js";
import { hybridSearch, threadChainScope } from "../../memory/retrieval.js";
import { enrichThreadHits } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createSearchThreadTool(input: ToolBuildInput, embedder: TextEmbedder) {
  return defineBotTool({
    description:
      "Search chat messages and file chunks in this thread and its fork ancestry. Use before claiming something was not discussed, when the user asks about prior chat details, or to find message ids for load_message.",
    inputSchema: z.object({ query: z.string(), limit: z.number().max(20).default(8) }),
    execute: async ({ query, limit }, signal) => {
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
        fileIds: scope.fileIds,
        query,
        k: limit,
        embedder,
        embeddingModel: embedder.model,
        logger: input.logger,
        signal,
      });
      const results = await enrichThreadHits(input.repos, scope.fileIds, hits);
      input.logger?.info("tool search_thread complete", {
        threadId: input.thread.id,
        results: results.length,
      });
      return { results };
    },
  });
}
