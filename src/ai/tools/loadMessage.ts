import { z } from "zod";
import { threadChainScope } from "../../memory/retrieval.js";
import {
  MAX_LOADED_MESSAGE_CHARS,
  defineBotTool,
  type LoadMessageResult,
  type ToolBuildInput,
} from "./types.js";

export function createLoadMessageTool(input: ToolBuildInput) {
  return defineBotTool<{ message_id: number }, LoadMessageResult>({
    description:
      "Load one previous message by numeric id from search_thread results or a user reference. Use when an exact earlier message, attached file metadata, or image context is needed.",
    inputSchema: z.object({ message_id: z.number() }),
    execute: async ({ message_id }): Promise<LoadMessageResult> => {
      input.logger?.debug("tool load_message starting", { threadId: input.thread.id, messageId: message_id });
      const row = await input.repos.messages.get(message_id);
      const scope = await threadChainScope(input.repos, input.thread);
      if (!row || !scope.messageIds.includes(row.id)) {
        input.logger?.debug("tool load_message not found", { threadId: input.thread.id, messageId: message_id });
        return { error: "message not found in this thread" };
      }
      const files = await input.repos.files.listForMessage(row.id);
      input.logger?.info("tool load_message complete", {
        threadId: input.thread.id,
        messageId: row.id,
        files: files.length,
      });
      return {
        message_id: row.id,
        role: row.role,
        kind: row.kind,
        text: row.text_plain.slice(0, MAX_LOADED_MESSAGE_CHARS),
        truncated: row.text_plain.length > MAX_LOADED_MESSAGE_CHARS,
        files: files.map((file) => ({
          file_id: file.id,
          type: file.type,
          name: file.name,
          summary: file.summary,
          inline: Boolean(file.is_inline),
        })),
        images: files
          .filter((file) => file.type === "image")
          .map((file) => ({
            file_id: file.id,
            name: file.name,
            caption: file.summary,
            path: file.path,
            telegram_file_id: file.telegram_file_id,
            note: file.telegram_file_id
              ? "image bytes will be redownloaded from Telegram into transient Pi context"
              : "image has no reusable Telegram file_id",
          })),
      };
    },
  });
}
