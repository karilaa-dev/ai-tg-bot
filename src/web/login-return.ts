import { isUuid } from "../utils/uuid.js";

export const loginFailures = ["expired", "cancelled", "denied", "start-bot", "try-again"] as const;
export type LoginFailure = typeof loginFailures[number];

/** OAuth may return to the chat, an identified conversation, or the admin dashboard. */
export function loginReturnPath(requested: string): string {
  if (requested === "/chat" || requested.startsWith("/chat?")) requested = "/chat/" + requested.slice(5);
  if (requested === "/" || requested === "/chat/" || requested === "/admin") return requested;
  const base = requested.startsWith("/chat/?") ? "/chat/" : "/";
  if (!requested.startsWith(base + "?")) return "/";
  const threads = new URLSearchParams(requested.slice(base.length + 1)).getAll("thread");
  const thread = threads[0];
  return threads.length === 1 && isUuid(thread) ? `${base}?thread=${thread}` : base;
}
