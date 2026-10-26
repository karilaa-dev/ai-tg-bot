import type { Transformer } from "grammy";

const notifying = new Set(["copyMessage", "copyMessages", "forwardMessage", "forwardMessages"]);

/** Messages the bot posts arrive without a notification sound. */
export function silentSends(): Transformer {
  return (previous, method, payload, signal) => previous(method,
    (method.startsWith("send") && method !== "sendChatAction" && !method.endsWith("Draft")) || notifying.has(method)
      ? { ...payload, disable_notification: true } : payload, signal);
}
