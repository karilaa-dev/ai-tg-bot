import { z } from "zod";
import { MAX_CREATED_FILES_PER_ANSWER } from "../../files/limits.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { toToolError } from "./helpers.js";
import { MAX_FILE_MB, defineBotTool, type ToolBuildInput } from "./types.js";

export const CreateFileSchema = z.object({
  path: z.string().regex(/^\//, "path must be an absolute virtual path"),
  name: z.string().min(1).max(255).optional(),
  mime: z.string().max(255).optional(),
  caption: z.string().max(1024).optional(),
  delivery: z.enum(["auto", "photo", "photo_only", "document"]).default("auto"),
});

export function createCreateFileTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      `Queue a file from this thread's E2B workspace for direct sandbox-to-Telegram delivery. Create files with relative Bash paths under /home/user/workspace, then pass the logical path (for example /report.txt). A later successful call for the same workspace path replaces its earlier pending attachment. The read-only /home/user/telegram-files directory cannot be exported as a created file; copy an attachment to the workspace first if needed. Attach at most ${MAX_CREATED_FILES_PER_ANSWER} files per answer. Files up to ${MAX_FILE_MB} MB are allowed unless they are compiled/native executables. Images use photo delivery when Telegram accepts them; auto and photo may fall back to documents. Use photo_only when the image must never be sent as a document. Select document when exact bytes or lossless metadata matter.`,
    inputSchema: CreateFileSchema,
    execute: async ({ path: virtualPath, name, mime, caption, delivery = "auto" }, signal) => {
      try {
        if (!input.outgoingFiles) throw new Error("Attachment queue is unavailable.");
        const result = await input.outgoingFiles.workspace([{ path: virtualPath, name, mime, caption, delivery }], signal);
        if (result.errors.length) throw new Error(result.errors[0]!.error.replace(/^Error: /, ""));
        const { attachment: prepared, replaced } = result.prepared[0]!;
        const used = input.outgoingFiles.items.length;
        input.logger?.info("tool create_file complete", {
          threadId: input.thread.id,
          fileId: prepared.fileId,
          name: prepared.name,
          type: prepared.type,
          bytes: prepared.size,
          replaced,
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
          status: `1 file ${replaced ? "replaced" : "attached"} (${used}/${MAX_CREATED_FILES_PER_ANSWER} used)`,
          attached_files_used: used,
          attached_files_limit: MAX_CREATED_FILES_PER_ANSWER,
        };
      } catch (err) {
        return toToolError(input, "create_file", err, { threadId: input.thread.id, path: virtualPath });
      }
    },
  });
}
