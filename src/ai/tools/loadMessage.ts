import { z } from "zod";
import { threadChainScope } from "../../memory/retrieval.js";
import { chatFileMarker } from "../../files/contextMarker.js";
import { isAbortError } from "../../files/cancel.js";
import type { FileRow } from "../../db/types.js";
import {
  MAX_LOADED_MESSAGE_CHARS,
  defineBotTool,
  type LoadMessageResult,
  type ToolBuildInput,
} from "./types.js";

const MAX_RELOADED_FILES = 5;

export function createLoadMessageTool(input: ToolBuildInput) {
  return defineBotTool<{ message_id: number; file_ids?: number[] }, LoadMessageResult>({
    description:
      "Load one previous chat message and its attachment metadata. Pass file_ids only for image bytes or legacy extracted document context. For source-only PDF/DOCX files, this selects their metadata without downloading bytes; call materialize_chat_files next.",
    inputSchema: z.object({
      message_id: z.number(),
      file_ids: z.array(z.number().int().positive()).max(MAX_RELOADED_FILES).optional(),
    }),
    execute: async ({ message_id, file_ids = [] }, signal): Promise<LoadMessageResult> => {
      input.logger?.debug("tool load_message starting", { threadId: input.thread.id, messageId: message_id });
      const row = await input.repos.messages.get(message_id);
      const scope = await threadChainScope(input.repos, input.thread);
      if (!row || !scope.messageIds.includes(row.id)) {
        input.logger?.debug("tool load_message not found", { threadId: input.thread.id, messageId: message_id });
        return { error: "message not found in this thread" };
      }
      const files = await input.repos.files.listForMessage(row.id);
      const requestedIds = [...new Set(file_ids)];
      const byId = new Map(files.map((file) => [file.id, file]));
      const invalidIds = requestedIds.filter((fileId) => !byId.has(fileId));
      if (invalidIds.length) return { error: `files not attached to message #${row.id}: ${invalidIds.join(", ")}` };
      const materializedIds: number[] = [];
      const durableIds: number[] = [];
      const sandboxIds: number[] = [];
      if (requestedIds.length) {
        for (const fileId of requestedIds) {
          const file = byId.get(fileId)!;
          if (file.type === "pdf" || file.type === "docx") {
            sandboxIds.push(fileId);
            continue;
          }
          try {
            if (!input.resolveFile) throw new Error("chat attachment byte access is unavailable");
            await input.resolveFile(file, signal);
            materializedIds.push(fileId);
          } catch (error) {
            if (isAbortError(error) || signal?.aborted || !await hasDurableDocumentContext(input, file)) throw error;
            durableIds.push(fileId);
            input.logger?.warn("tool load_message using durable extracted document context", {
              threadId: input.thread.id,
              messageId: row.id,
              fileId,
              error: String(error),
            });
          }
        }
        input.selectContextFiles?.(materializedIds);
        input.selectContextFiles?.(sandboxIds);
        (input.selectDurableContextFiles ?? input.selectContextFiles)?.(durableIds);
      }
      input.logger?.info("tool load_message complete", {
        threadId: input.thread.id,
        messageId: row.id,
        files: files.length,
        materializedFiles: materializedIds,
        durableFiles: durableIds,
        sandboxFiles: sandboxIds,
      });
      return {
        message_id: row.id,
        role: row.role,
        kind: row.kind,
        text: row.text_plain.slice(0, MAX_LOADED_MESSAGE_CHARS),
        truncated: row.text_plain.length > MAX_LOADED_MESSAGE_CHARS,
        files: files.map((file) => ({
          file_id: file.id,
          marker: chatFileMarker(file.id),
          type: file.type,
          name: file.name,
          summary: file.summary,
          inline: Boolean(file.is_inline),
          bash_input_file_id: file.id,
          source_only: file.extraction_status === "source_only",
          recommended_tool: file.type === "pdf" || file.type === "docx"
            ? "materialize_chat_files" as const
            : "load_message" as const,
        })),
        images: files
          .filter((file) => file.type === "image")
          .map((file) => ({
            file_id: file.id,
            marker: chatFileMarker(file.id),
            name: file.name,
            caption: file.summary,
            note: materializedIds.includes(file.id)
              ? "image bytes were selected for transient Pi context"
              : "pass this file_id in load_message.file_ids to restore image bytes for this turn",
          })),
        materialized_file_ids: materializedIds,
        durable_file_ids: durableIds,
        sandbox_file_ids: sandboxIds,
      };
    },
  });
}

async function hasDurableDocumentContext(input: ToolBuildInput, file: FileRow): Promise<boolean> {
  if (file.type === "image" || file.type === "other" || file.extraction_status !== "ready") return false;
  if (file.is_inline) return file.content_md !== null;
  return (await input.repos.files.chunks(file.id)).length > 0;
}
