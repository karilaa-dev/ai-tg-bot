import { z } from "zod";
import { MAX_CREATED_FILES_PER_ANSWER } from "../../files/limits.js";
import { CreateFileSchema } from "./createFile.js";
import { toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createFinishResponseTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description: "Finish the turn with optional final text and workspace files, using create_file fields and limits. Call as the ONLY tool in a response after all work and visual checks. Prepares two files at a time and queues successes in requested order. Existing paths replace pending attachments. On partial failure, successes stay queued: repair failed files only, then call again. Success ends inference; final text is sent before queued files.",
    inputSchema: z.object({
      text: z.string().max(32_000).optional(),
      files: z.array(CreateFileSchema).max(MAX_CREATED_FILES_PER_ANSWER).optional(),
    }),
    execute: async ({ text, files = [] }, signal) => {
      try {
        signal?.throwIfAborted();
        if (!input.outgoingFiles) throw new Error("Attachment queue is unavailable.");
        if (!input.responseDraft) throw new Error("Response draft is unavailable.");
        if (text !== undefined) input.responseDraft.text = text.trim();
        if (!input.responseDraft.text && !files.length && !input.outgoingFiles.items.length) throw new Error("Provide final text or files.");
        const result = await input.outgoingFiles.workspace(files, signal);
        const prepared = result.prepared.map(({ attachment }) => ({ file_id: attachment.fileId, path: attachment.sourceVirtualPath! }));
        const errors = input.outgoingFiles.unresolved;
        if (errors.length) return { completed: false, error: "Some files could not be prepared. Repair only failed paths, then finish_response again.", prepared, errors };
        return { completed: true, text: input.responseDraft.text, file_ids: input.outgoingFiles.items.map((file) => file.fileId) };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return { completed: false, ...toToolError(input, "finish_response", error, { threadId: input.thread.id }) };
      }
    },
  });
}
