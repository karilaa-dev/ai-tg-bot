import type { Api } from "grammy";
import type { ConversationLink } from "../application/conversations.js";
import { ConversationError } from "../application/errors.js";
import type { Logger } from "../logger.js";

export function telegramConversationLink(api: Api, logger: Logger, required = false): ConversationLink {
  return {
    async create(userId, title) {
      try {
        const me = await api.getMe();
        if (!me.has_topics_enabled) {
          if (required) throw new ConversationError(409, "Enable topics for this bot before creating a Telegram conversation.");
          return null;
        }
        return (await api.createForumTopic(userId, title)).message_thread_id;
      } catch (error) {
        if (required) throw error;
        logger.warn("conversation created without Telegram topic", { userId, error: String(error) });
        return null;
      }
    },
    async remove(userId, topicId) { await api.deleteForumTopic(userId, topicId); },
  };
}
