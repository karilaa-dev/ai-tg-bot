import { z } from "zod";
import { imageMediaTypeFromName } from "../../files/mediaType.js";
import { threadChainScope } from "../../memory/retrieval.js";
import { readCachedOrRedownloadImage } from "./helpers.js";
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
              ? "image bytes are cached locally and can be redownloaded from Telegram if missing"
              : "image bytes are available from the stored file path for reload",
          })),
      };
    },
    toModelOutput: async ({ output }) => {
      if ("error" in output) return { type: "json", value: output as never };
      const result = output;
      const imageParts = [];
      for (const image of result.images ?? []) {
        try {
          const data = await readCachedOrRedownloadImage(input, image);
          imageParts.push({ type: "image-data" as const, data: data.toString("base64"), mediaType: imageMediaTypeFromName(image.name) ?? "image/*" });
        } catch (err) {
          input.logger?.warn("tool load_message image reload failed", {
            fileId: image.file_id,
            err: String(err),
          });
          imageParts.push({
            type: "text" as const,
            text: `[image #${image.file_id} could not be reloaded: ${String(err)}]`,
          });
        }
      }
      if (!imageParts.length) return { type: "json", value: result as never };
      return {
        type: "content",
        value: [
          {
            type: "text" as const,
            text: JSON.stringify({
              message_id: result.message_id,
              role: result.role,
              kind: result.kind,
              text: result.text,
              truncated: result.truncated,
              files: result.files,
              images: result.images?.map((image) => ({
                file_id: image.file_id,
                name: image.name,
                caption: image.caption,
              })),
            }),
          },
          ...imageParts,
        ],
      } as never;
    },
  });
}
