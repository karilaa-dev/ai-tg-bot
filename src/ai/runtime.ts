import type { ThreadRow, UserRow } from "../db/types.js";
import type { ThreadBridge } from "../codex/threadBridge.js";
import type { ThreadTitlePromptInput } from "./threadTitle.js";

export interface TextContent { type: "text"; text: string }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ToolCallContent { type: "toolCall"; id: string; name: string; arguments: unknown }
export interface ThinkingContent { type: "thinking"; thinking: string }
export interface ModelUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cacheWrite1h?: number; reasoning?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | ToolCallContent | ThinkingContent>;
  provider: string; model: string; responseModel?: string;
  usage: ModelUsage; stopReason: string; errorMessage?: string; timestamp: number;
}
export type AgentMessage = AssistantMessage
  | { role: "user"; content: string | Array<TextContent | ImageContent>; timestamp: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: Array<TextContent | ImageContent>; details?: unknown; isError: boolean; timestamp: number; usage?: ModelUsage };
export type SessionEntry = { type: "message"; id: string; message: AgentMessage }
  | { type: "compaction" | "branch_summary"; id: string; usage?: ModelUsage };
export type AgentSessionEvent =
  | { type: "turn_start" }
  | { type: "message_end"; message: AgentMessage }
  | { type: "message_update"; assistantMessageEvent: { type: "text_delta" | "thinking_delta"; delta: string } | { type: "thinking_start" | "thinking_end" } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export interface AgentSession {
  readonly sessionId: string;
  readonly model?: { id: string };
  readonly isStreaming: boolean;
  readonly sessionManager: { getEntries(): SessionEntry[] };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  abort(): Promise<void>;
  acknowledgeDelivery?(messageId: number): Promise<void>;
  getSessionStats(): { totalMessages: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
}
export interface AgentRuntimeService {
  runtime(thread: ThreadRow, user: UserRow): Promise<{ session: AgentSession; bridge: Pick<ThreadBridge, "beginTurn" | "endTurn" | "attachments" | "outgoingBuffers" | "publishedWebsites" | "currentTurnBudget" | "outgoingFiles">; lastUsedAt: number }>;
  compact(thread: ThreadRow, user: UserRow, signal?: AbortSignal): Promise<number>;
  fork(source: ThreadRow, target: ThreadRow, user: UserRow, entryId?: string | null, signal?: AbortSignal): Promise<void>;
  captionImage(bytes: Buffer, mimeType: string, userCaption?: string): Promise<string>;
  generateThreadTitle(input: ThreadTitlePromptInput): Promise<string>;
  abort(threadId: number): Promise<boolean>;
  dispose(): Promise<void>;
}

export function emptyModelUsage(): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
