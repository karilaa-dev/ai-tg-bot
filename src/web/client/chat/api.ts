import { AttachmentCache, type AttachmentSource } from "../attachments.js";
import type { ChatHistory, ChatSendResult, ChatSession, ChatSettings, ChatSettingsPatch, ChatThread } from "../../chat-types.js";
import type { WebMemories, WebMessage, WebPage } from "../../types.js";
import { localizeServerError, type UiLanguage } from "../i18n.js";

export const CHAT_SESSION_EXPIRED_EVENT = "chat-session-expired";
let sessionGeneration = 0;
let sessionUserId: number | null = null;
let attachmentSource: AttachmentSource | null = null;
export function bindChatRequests(userId: number) {
  invalidateChatRequests();
  sessionUserId = userId;
  const generation = sessionGeneration;
  attachmentSource = {
    cache: new AttachmentCache(),
    url: (threadId, fileId) => `/api/chat/threads/${threadId}/files/${fileId}`,
    fetch: (url, init) => {
      if (generation !== sessionGeneration || sessionUserId !== userId) return Promise.reject(new DOMException("Session ended", "AbortError"));
      return chatFetch(url, init);
    },
  };
}
export function invalidateChatRequests() {
  sessionGeneration++;
  sessionUserId = null;
  attachmentSource?.cache?.dispose();
  attachmentSource = null;
}
export function getChatAttachmentSource(): AttachmentSource {
  if (!attachmentSource) throw new Error("File access requires a verified chat session.");
  return attachmentSource;
}

export type ChatMessage = WebMessage;

export class ChatApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const fallbackMessage = (status: number) => status === 429 ? "Too many requests. Wait a moment and try again."
  : status === 413 ? "These files are too large to send."
  : status >= 500 ? "The bot could not complete this request. Try again."
  : "The request could not be completed. Try again.";

function errorText(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  return typeof body.error === "string" && body.error ? body.error : null;
}

/** Every chat request is same-origin; writes carry the CSRF marker the server requires. */
export async function chatFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const generation = sessionGeneration;
  const headers = new Headers(init.headers);
  if (sessionUserId !== null) headers.set("X-Chat-User", String(sessionUserId));
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) headers.set("X-Chat-Request", "1");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) {
    if (url !== "/api/chat/session" && generation === sessionGeneration && !init.signal?.aborted) window.dispatchEvent(new Event(CHAT_SESSION_EXPIRED_EVENT));
    throw new ChatApiError("Your session ended. Sign in again to continue.", 401);
  }
  return response;
}

async function chatJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await chatFetch(url, init);
  const raw = await response.text();
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* Proxies can return HTML error pages. */ }
  if (!response.ok) throw new ChatApiError(errorText(body) ?? fallbackMessage(response.status), response.status);
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => body === undefined
  ? { method }
  : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

export interface ChatReadResult { readMessageId: number | null; unread: boolean }

export type HistoryCursor = { before: number } | { after: number } | null;

export const chatApi = {
  session: (signal?: AbortSignal) => chatJson<ChatSession>("/api/chat/session", { signal }),
  logout: () => chatJson<unknown>("/api/chat/session", json("DELETE")),
  /** 200 with the Telegram profile photo, or 204 when the account has none. */
  avatar: (signal: AbortSignal) => chatFetch("/api/chat/avatar", { signal }),
  /** `query` searches titles and visible messages across every thread, keeping the same pagination. */
  threads: (offset: number, signal?: AbortSignal, query = "") => {
    const params = new URLSearchParams({ offset: String(offset) });
    if (query.trim()) params.set("q", query.trim().slice(0, MAX_SEARCH_LENGTH));
    return chatJson<WebPage<ChatThread>>(`/api/chat/threads?${params}`, { signal });
  },
  createThread: (title?: string) => chatJson<ChatThread>("/api/chat/threads", json("POST", title ? { title } : {})),
  history: (threadId: number, cursor: HistoryCursor, signal: AbortSignal) => {
    const query = cursor === null ? "" : "before" in cursor ? `?before=${cursor.before}` : `?after=${cursor.after}`;
    return chatJson<ChatHistory>(`/api/chat/threads/${threadId}/messages${query}`, { signal });
  },
  send: (threadId: number, input: { text: string; requestId: string; files: File[] }) => {
    const url = `/api/chat/threads/${threadId}/messages`;
    if (!input.files.length) return chatJson<ChatSendResult>(url, json("POST", { text: input.text, requestId: input.requestId }));
    const form = new FormData();
    form.set("text", input.text);
    form.set("requestId", input.requestId);
    for (const file of input.files) form.append("files", file, file.name);
    return chatJson<ChatSendResult>(url, { method: "POST", body: form });
  },
  stop: (threadId: number) => chatJson<unknown>(`/api/chat/threads/${threadId}/stop`, json("POST", {})),
  fork: (threadId: number, messageId?: number) => chatJson<ChatThread>(`/api/chat/threads/${threadId}/fork`, json("POST", messageId === undefined ? {} : { messageId })),
  compact: (threadId: number) => chatJson<unknown>(`/api/chat/threads/${threadId}/compact`, json("POST", {})),
  /** The server keeps the cursor monotonic, so a late or repeated acknowledgement never marks newer messages read. */
  markRead: (threadId: number, messageId: number, signal?: AbortSignal) =>
    chatJson<ChatReadResult>(`/api/chat/threads/${threadId}/read`, { ...json("POST", { messageId }), signal }),
  settings: (signal?: AbortSignal) => chatJson<ChatSettings>("/api/chat/settings", { signal }),
  updateSettings: (patch: ChatSettingsPatch) => chatJson<ChatSettings>("/api/chat/settings", json("PATCH", patch)),
  memories: (offset: number, signal: AbortSignal) => chatJson<WebMemories>(`/api/chat/memories?offset=${offset}`, { signal }),
  deleteMemory: async (memoryId: number) => { await chatJson<{ deleted: true }>(`/api/chat/memories/${memoryId}`, json("DELETE")); },
  fileUrl: (threadId: number, fileId: number) => `/api/chat/threads/${threadId}/files/${fileId}`,
};

export const MAX_SEARCH_LENGTH = 200;

/** Server and status messages in the interface language; network failures read as the caller's fallback. */
export function describeError(error: unknown, fallback: string, language: UiLanguage): string {
  return error instanceof ChatApiError ? localizeServerError(error.message, language, error.status) : fallback;
}
export const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
