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
      "Load one previous chat message by numeric id from search_thread results or a user reference. Without file_ids this returns attachment metadata without loading bytes. Pass up to five attachment ids from that message only when their exact bytes or live image/document context is needed. Ready documents fall back to their durable extracted text if the chat source is unavailable.",
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
      if (requestedIds.length) {
        for (const fileId of requestedIds) {
          const file = byId.get(fileId)!;
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
        (input.selectDurableContextFiles ?? input.selectContextFiles)?.(durableIds);
      }
      input.logger?.info("tool load_message complete", {
        threadId: input.thread.id,
        messageId: row.id,
        files: files.length,
        materializedFiles: materializedIds,
        durableFiles: durableIds,
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
          bash_path: `/attachments/${file.id}`,
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
      };
    },
  });
}

async function hasDurableDocumentContext(input: ToolBuildInput, file: FileRow): Promise<boolean> {
  if (file.type === "image" || file.type === "other" || file.extraction_status !== "ready") return false;
  if (file.is_inline) return file.content_md !== null;
  return (await input.repos.files.chunks(file.id)).length > 0;
}
