import { isUuid } from "../utils/uuid.js";

/** OAuth may return to the chat, an identified conversation, or the admin dashboard. */
export function loginReturnPath(requested: string): string {
  if (requested === "/" || requested === "/admin") return requested;
  if (!requested.startsWith("/?")) return "/";
  const threads = new URLSearchParams(requested.slice(2)).getAll("thread");
  const thread = threads[0];
  return threads.length === 1 && isUuid(thread) ? `/?thread=${thread}` : "/";
}
