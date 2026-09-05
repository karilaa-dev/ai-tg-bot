import { z } from "zod";
import { hybridSearch } from "../../memory/retrieval.js";
import { getScopedFile } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createSearchInFileTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      "Lexically search chunks of a large TXT or CSV attachment by file_id. PDF and DOCX files are source-only and must be inspected with materialize_chat_files plus sandbox tools.",
    inputSchema: z.object({
      file_id: z.number(),
      query: z.string(),
      limit: z.number().max(20).default(8),
    }),
    execute: async ({ file_id, query, limit }, signal) => {
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
      if (file.type === "audio") {
        return { error: "transcription_required", file_id, message: "Use transcribe_audio to read this audio file." };
      }
      if (file.extraction_status === "source_only") {
        return {
          error: "sandbox_required",
          file_id,
          message: "This PDF or DOCX is read in E2B. Call materialize_chat_files, then use PDF Inspector or docx-cli.",
        };
      }
      const hits = await hybridSearch({
        search: input.db.search,
        repos: input.repos,
        threadIds: [],
        messageIds: [],
        fileIds: [file_id],
        query,
        k: limit,
        logger: input.logger,
        signal,
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
