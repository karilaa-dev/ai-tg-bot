import { autoRetry } from "@grammyjs/auto-retry";
import type { Transformer } from "grammy";

export function telegramRetry(): Transformer {
  const retry = autoRetry();
  const retryRejected = autoRetry({ rethrowHttpErrors: true, rethrowInternalServerErrors: true });
  return (previous, method, payload, signal) => {
    // Sends have no idempotency key: a lost acknowledgment may already have
    // created the message. Flood-wait rejections remain safe to retry.
    const createsMessage = /^(send|copy|forward)/.test(method)
      && !["sendChatAction", "sendMessageDraft", "sendRichMessageDraft"].includes(method);
    return (createsMessage || method === "createForumTopic" ? retryRejected : retry)(previous, method, payload, signal);
  };
}
