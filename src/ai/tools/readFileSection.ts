import { z } from "zod";
import { decodeOutline } from "../../files/ingest.js";
import { getScopedFile } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createReadFileSectionTool(input: ToolBuildInput) {
  return defineBotTool({
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
      const file = await getScopedFile(input, file_id);
      if (!file) {
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
  });
}
