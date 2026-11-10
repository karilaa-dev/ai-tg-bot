import type { Api } from "grammy";
import type { ConversationLink } from "../application/conversations.js";
import { ConversationError } from "../application/errors.js";
import type { Logger } from "../logger.js";

export function telegramConversationLink(api: Api, logger: Logger, required = false): ConversationLink {
  return {
    async create(userId, title, signal) {
      try {
        // grammY types use the older abort-controller interface; native signals implement it.
        const telegramSignal = signal as Parameters<Api["getMe"]>[0];
        const me = await api.getMe(telegramSignal);
        if (!me.has_topics_enabled) {
          if (required) throw new ConversationError(409, "Enable topics for this bot before creating a Telegram conversation.");
          return null;
        }
        return (await api.createForumTopic(userId, title, {}, telegramSignal)).message_thread_id;
      } catch (error) {
        signal?.throwIfAborted();
        if (required) throw error;
        logger.warn("conversation created without Telegram topic", { userId, error: String(error) });
        return null;
      }
    },
    async remove(userId, topicId) { await api.deleteForumTopic(userId, topicId); },
  };
}
