import { z } from "zod";
import type { TextEmbedder } from "../../memory/embeddings.js";
import { hybridSearch } from "../../memory/retrieval.js";
import { getScopedFile } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createSearchInFileTool(input: ToolBuildInput, embedder: TextEmbedder) {
  return defineBotTool({
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
      const file = await getScopedFile(input, file_id);
      if (!file) {
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
  });
}
