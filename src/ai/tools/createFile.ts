import { z } from "zod";
import { MAX_CREATED_FILES_PER_ANSWER } from "../../files/limits.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { assertCreatedFileCapacity, prepareCreatedFile, toToolError } from "./helpers.js";
import { MAX_FILE_MB, defineBotTool, type ToolBuildInput } from "./types.js";

export function createCreateFileTool(input: ToolBuildInput) {
  return defineBotTool({
    description:
      `Queue a file that you created in this thread's bash workspace to send back through the active chat. First create the file with bash, then call this tool with its absolute virtual path. Attach at most ${MAX_CREATED_FILES_PER_ANSWER} files per answer; do not call create_file more than ${MAX_CREATED_FILES_PER_ANSWER} times in one answer. If more files are needed, send the first ${MAX_CREATED_FILES_PER_ANSWER} and say the rest can be sent in another answer. Files up to ${MAX_FILE_MB} MB are allowed unless they are native/compiled executables such as exe, dll, ELF/Mach-O binaries, shared libraries, Java bytecode archives, or WebAssembly. Scripts and source files such as sh, bash, ps1, py, js, ts, and similar text/code files are allowed. Images are sent as photos by default; set delivery to document when exact bytes, transparency, metadata, print/source assets, or uncompressed delivery matters.`,
    inputSchema: z.object({
      path: z.string().regex(/^\//, "path must be an absolute virtual path"),
      name: z.string().min(1).max(255).optional(),
      mime: z.string().max(255).optional(),
      caption: z.string().max(1024).optional(),
      delivery: z.enum(["auto", "photo", "document"]).default("auto"),
    }),
    execute: async ({ path: virtualPath, name, mime, caption, delivery = "auto" }) => {
      try {
        const usedBefore = assertCreatedFileCapacity(input);
        input.logger?.info("tool create_file starting", {
          threadId: input.thread.id,
          path: virtualPath,
          name: name ?? null,
          mime: mime ?? null,
        });
        const prepared = await prepareCreatedFile(input, { virtualPath, name, mime, caption, delivery });
        input.createdFiles?.push(prepared);
        const used = usedBefore + 1;
        input.logger?.info("tool create_file complete", {
          threadId: input.thread.id,
          fileId: prepared.fileId,
          name: prepared.name,
          type: prepared.type,
          bytes: prepared.size,
          filesUsed: used,
          filesLimit: MAX_CREATED_FILES_PER_ANSWER,
        });
        return {
          file_id: prepared.fileId,
          marker: chatFileMarker(prepared.fileId),
          name: prepared.name,
          type: prepared.type,
          size: prepared.size,
          caption: prepared.caption ?? null,
          status: `1 file attached (${used}/${MAX_CREATED_FILES_PER_ANSWER} used)`,
          attached_files_used: used,
          attached_files_limit: MAX_CREATED_FILES_PER_ANSWER,
        };
      } catch (err) {
        return toToolError(input, "create_file", err, { threadId: input.thread.id, path: virtualPath });
      }
    },
  });
}
