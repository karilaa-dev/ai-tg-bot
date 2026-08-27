import { z } from "zod";
import { MAX_CREATED_FILES_PER_ANSWER } from "../../files/limits.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { assertCreatedFileCapacity, normalizeBashCwd, prepareCreatedFile, toToolError } from "./helpers.js";
import { MAX_FILE_MB, defineBotTool, type ToolBuildInput } from "./types.js";

export function createCreateFileTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      `Queue a file from this thread's E2B workspace for direct sandbox-to-Telegram delivery. Create files with relative Bash paths under /home/user/workspace, then pass the logical path (for example /report.txt). A later successful call for the same workspace path replaces its earlier pending attachment. The read-only /home/user/telegram-files directory cannot be exported as a created file; copy an attachment to the workspace first if needed. Attach at most ${MAX_CREATED_FILES_PER_ANSWER} files per answer. Files up to ${MAX_FILE_MB} MB are allowed unless they are compiled/native executables. Images use photo delivery when Telegram accepts them; auto and photo may fall back to documents. Use photo_only when the image must never be sent as a document. Select document when exact bytes or lossless metadata matter.`,
    inputSchema: z.object({
      path: z.string().regex(/^\//, "path must be an absolute virtual path"),
      name: z.string().min(1).max(255).optional(),
      mime: z.string().max(255).optional(),
      caption: z.string().max(1024).optional(),
      delivery: z.enum(["auto", "photo", "photo_only", "document"]).default("auto"),
    }),
    execute: async ({ path: virtualPath, name, mime, caption, delivery = "auto" }, signal) => {
      try {
        const sourceVirtualPath = normalizeBashCwd(virtualPath);
        const replacementIndex = input.createdFiles?.findIndex((attachment) =>
          attachment.sourceVirtualPath === sourceVirtualPath) ?? -1;
        const usedBefore = replacementIndex >= 0
          ? input.createdFiles?.length ?? 0
          : assertCreatedFileCapacity(input);
        input.logger?.info("tool create_file starting", {
          threadId: input.thread.id,
          path: virtualPath,
          name: name ?? null,
          mime: mime ?? null,
        });
        const prepared = await prepareCreatedFile(input, { virtualPath, name, mime, caption, delivery }, signal);
        const replaced = replacementIndex >= 0 && input.createdFiles
          ? input.createdFiles.splice(replacementIndex, 1, prepared)[0]
          : undefined;
        if (!replaced) input.createdFiles?.push(prepared);
        if (replaced && replaced.fileId !== prepared.fileId) {
          await input.repos.files.deleteFile(replaced.fileId).catch((error) => {
            input.logger?.warn("failed to remove replaced created file", {
              threadId: input.thread.id,
              oldFileId: replaced.fileId,
              newFileId: prepared.fileId,
              path: sourceVirtualPath,
              err: String(error),
            });
          });
        }
        const used = replaced ? usedBefore : usedBefore + 1;
        input.logger?.info("tool create_file complete", {
          threadId: input.thread.id,
          fileId: prepared.fileId,
          name: prepared.name,
          type: prepared.type,
          bytes: prepared.size,
          replacedFileId: replaced?.fileId ?? null,
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
