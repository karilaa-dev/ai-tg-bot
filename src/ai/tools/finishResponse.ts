import { z } from "zod";
import { MAX_CREATED_FILES_PER_ANSWER } from "../../files/limits.js";
import { prepareWithTwoWorkers } from "../../files/outgoingBuffers.js";
import { CreateFileSchema } from "./createFile.js";
import { normalizeCreatedFilePath, prepareCreatedFile, toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createFinishResponseTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description: "Finish the turn with optional final text and workspace files, using create_file fields and limits. Call as the ONLY tool in a response after all work and visual checks. Prepares two files at a time and queues successes in requested order. Existing paths replace pending attachments. On partial failure, successes stay queued: repair failed files only, then call again. Success ends inference; final text is sent before queued files.",
    inputSchema: z.object({
      text: z.string().max(32_000).optional(),
      files: z.array(CreateFileSchema).max(MAX_CREATED_FILES_PER_ANSWER).optional(),
    }),
    execute: async ({ text = "", files = [] }, signal) => {
      try {
        signal?.throwIfAborted();
        if (!input.createdFiles) throw new Error("Attachment queue is unavailable.");
        if (!text.trim() && !files.length && !input.createdFiles.length) throw new Error("Provide final text or files.");
        const paths = files.map((file) => normalizeCreatedFilePath(file.path));
        if (new Set(paths).size !== paths.length) throw new Error("File paths must be unique.");
        const pendingPaths = new Set(input.createdFiles.map((file) => file.sourceVirtualPath));
        // The tool is sequential. Reserve every new queue slot before starting either worker.
        if (input.createdFiles.length + paths.filter((path) => !pendingPaths.has(path)).length > MAX_CREATED_FILES_PER_ANSWER) {
          throw new Error(`File limit reached: at most ${MAX_CREATED_FILES_PER_ANSWER} files per answer.`);
        }
        const order = input.createdFileOrder ??= [];
        for (const key of [...input.createdFiles.map((file) => file.sourceVirtualPath ?? `#${file.fileId}`), ...paths]) {
          if (!order.includes(key)) order.push(key);
        }
        const results = await prepareWithTwoWorkers(files, async (file) => {
          signal?.throwIfAborted();
          return prepareCreatedFile(input, { ...file, virtualPath: file.path }, signal);
        });
        if (signal?.aborted) {
          for (const result of results) if (result.status === "fulfilled") {
            input.outgoingBuffers?.release(result.value);
            await input.repos.files.deleteFile(result.value.fileId);
          }
          signal.throwIfAborted();
        }
        const errors: Array<{ path: string; error: string }> = [];
        const prepared: Array<{ file_id: number; path: string }> = [];
        for (let index = 0; index < results.length; index++) {
          const result = results[index]!;
          if (result.status === "rejected") {
            errors.push({ path: paths[index]!, error: String(result.reason) });
            continue;
          }
          const attachment = result.value;
          const replacementIndex = input.createdFiles.findIndex((existing) => existing.sourceVirtualPath === paths[index]);
          if (replacementIndex < 0) input.createdFiles.push(attachment);
          else {
            const replaced = input.createdFiles.splice(replacementIndex, 1, attachment)[0]!;
            input.outgoingBuffers?.release(replaced);
            await input.repos.files.deleteFile(replaced.fileId).catch((error) => {
              input.logger?.warn("failed to remove replaced created file", { threadId: input.thread.id, fileId: replaced.fileId, error: String(error) });
            });
          }
          prepared.push({ file_id: attachment.fileId, path: paths[index]! });
        }
        input.createdFiles.sort((a, b) => order.indexOf(a.sourceVirtualPath ?? `#${a.fileId}`) - order.indexOf(b.sourceVirtualPath ?? `#${b.fileId}`));
        if (errors.length) return { completed: false, error: "Some files could not be prepared. Repair only failed paths, then finish_response again.", prepared, errors };
        return { completed: true, text: text.trim(), file_ids: input.createdFiles.map((file) => file.fileId) };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return { completed: false, ...toToolError(input, "finish_response", error, { threadId: input.thread.id }) };
      }
    },
  });
}
