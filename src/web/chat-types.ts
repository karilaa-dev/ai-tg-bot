import type { WebHistory, WebMemories, WebPage, WebThread, WebUsageReport } from "./types.js";
import type { TurnDraft } from "../ai/types.js";

export interface ChatProfile {
  id: number;
  name: string | null;
  username: string | null;
}

export type ChatSession =
  | { authenticated: false; loginAvailable: boolean }
  | { authenticated: true; user: ChatProfile; botUsername: string; admin: boolean };

export interface ChatSettings {
  language: "en" | "ru";
  /** An IANA zone such as Europe/Berlin, or null when none is named. */
  timeZone: string | null;
  /** The current offset in minutes, from the named zone or an offset saved in Telegram; read-only. */
  timezoneOffsetMinutes: number | null;
  streaming: boolean;
  memoryEnabled: boolean;
}

export type ChatSettingsPatch = Partial<Omit<ChatSettings, "timezoneOffsetMinutes">>;

export interface ChatThread extends WebThread {
  origin: "telegram" | "web";
  topicId: number | null;
  unread: boolean;
  lastMessageId: number | null;
}

export interface ChatHistory extends Omit<WebHistory, "thread"> {
  thread: ChatThread;
  draft?: TurnDraft | null;
}

export interface ChatSendResult {
  turnId: number;
  messageId: number;
  queued: boolean;
}

export type ChatUploadFile = Pick<File, "name" | "size" | "type" | "arrayBuffer">;

/** User ids here always come from the verified session, never a request body. */
export interface ChatService {
  profile(userId: number): Promise<ChatProfile>;
  /** The account's current Telegram profile photo, or null when it has none or hides it from bots. */
  avatar(userId: number): Promise<{ bytes: Uint8Array; mime: string } | null>;
  threads(userId: number, offset: number, search?: string): Promise<WebPage<ChatThread>>;
  history(userId: number, threadId: string, before?: number, after?: number): Promise<ChatHistory>;
  requireThread(userId: number, threadId: string): Promise<void>;
  markRead(userId: number, threadId: string, messageId: number): Promise<{ readMessageId: number | null; unread: boolean }>;
  createThread(userId: number, title?: string): Promise<ChatThread>;
  send(userId: number, threadId: string, input: { text: string; requestId: string; files?: ChatUploadFile[] }): Promise<ChatSendResult>;
  stop(userId: number, threadId: string): Promise<void>;
  fork(userId: number, threadId: string, messageId?: number): Promise<ChatThread>;
  compact(userId: number, threadId: string): Promise<void>;
  settings(userId: number): Promise<ChatSettings>;
  updateSettings(userId: number, patch: ChatSettingsPatch): Promise<ChatSettings>;
  memories(userId: number, offset: number): Promise<WebMemories>;
  deleteMemory(userId: number, memoryId: number): Promise<void>;
  usage(userId: number, days: number, signal?: AbortSignal): Promise<WebUsageReport>;
}
