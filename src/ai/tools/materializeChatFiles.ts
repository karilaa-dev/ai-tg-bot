import { z } from "zod";
import { resolveThreadFileDescriptors } from "../../e2b/threadFiles.js";
import type { FileRow } from "../../db/types.js";
import { getScopedFile } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const MAX_FILES_PER_CALL = 5;

export function createMaterializeChatFilesTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description:
      "Restore selected Telegram attachments into this thread's persistent E2B sandbox. Returns exact read-only paths and format-specific tool guidance. Call this before using bash, PDF Inspector, or docx-cli on an attachment. Pass only file ids shown in chat-file markers or load_message results.",
    inputSchema: z.object({
      file_ids: z.array(z.number().int().positive()).min(1).max(MAX_FILES_PER_CALL),
    }),
    execute: async ({ file_ids }, signal) => {
      const startedAt = Date.now();
      if (!input.commandRuntime) return { error: "E2B command runtime is unavailable." };
      const requestedIds = [...new Set(file_ids)];
      const scoped = await Promise.all(requestedIds.map((fileId) => getScopedFile(input, fileId)));
      const scopedFiles = scoped.filter((file): file is FileRow => Boolean(file));
      const descriptors = await resolveThreadFileDescriptors(input, signal, scopedFiles.map((file) => file.id));
      const sync = descriptors.length
        ? await input.commandRuntime.materializeFiles({
            userId: input.user.tg_id,
            threadId: input.thread.id,
            files: descriptors,
            signal,
          })
        : { directory: "/home/user/telegram-files", available: 0, files: [] };
      const restored = new Map(sync.files.map((file) => [file.fileId, file]));
      const fileById = new Map(scopedFiles.map((file) => [file.id, file]));
      const files = requestedIds.map((fileId) => {
        const file = fileById.get(fileId);
        if (!file) {
          return {
            file_id: fileId,
            original_name: null,
            mime_type: null,
            path: null,
            status: "source_unavailable" as const,
            recommended_tools: [],
            error_code: "file_not_found_in_thread",
          };
        }
        const materialized = restored.get(fileId);
        return {
          file_id: fileId,
          original_name: file.name,
          mime_type: file.mime_type,
          path: materialized?.path ?? null,
          status: materialized?.status ?? "source_unavailable" as const,
          recommended_tools: recommendedTools(file),
          ...(materialized?.errorCode
            ? { error_code: materialized.errorCode }
            : materialized ? {} : { error_code: "restorable_source_missing" }),
        };
      });
      input.logger?.info("tool materialize_chat_files complete", {
        threadId: input.thread.id,
        requested: requestedIds.length,
        available: files.filter((file) => file.status === "available").length,
        latencyMs: Date.now() - startedAt,
        statuses: files.map((file) => ({ fileId: file.file_id, status: file.status })),
      });
      return { directory: sync.directory, files };
    },
  });
}

function recommendedTools(file: FileRow): string[] {
  if (file.type === "audio") return [`transcribe_audio({ file_id: ${file.id} })`];
  if (file.type === "pdf") {
    return [
      "pdf-inspector detect <path> --json",
      "pdf-inspector <path> -o /home/user/workspace/<name>.md",
      `render_pdf_pages({ file_id: ${file.id}, pages: [1] }) for scanned or image-only pages`,
    ];
  }
  if (file.type === "docx") {
    return [
      "docx outline <path>",
      "docx read <path>",
    ];
  }
  if (file.type === "image") return ["load_message with this file id for model vision"];
  return ["rg, sed, awk, file, or another relevant sandbox command"];
}
