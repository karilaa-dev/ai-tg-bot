import type { InferenceUsageCall } from "../pi/usage.js";
import type { CompactionAction } from "../application/compactionAction.js";
import type { MemoryPage } from "../memory/view.js";
import type { ToolActivity } from "../ai/toolActivity.js";
import type { OpenUiLanguage } from "../openui/language.js";

export interface WebMemories extends MemoryPage {
  user: WebUser;
  enabled: boolean;
}

export interface WebUser {
  id: number;
  name: string | null;
  username: string | null;
  lastActivity: number;
  threadCount: number;
}

export function userLabel(user: Pick<WebUser, "id" | "name" | "username">): string {
  return user.username ? `@${user.username}` : user.name || `User ${user.id}`;
}

export interface WebThreadActivity {
  state: "queued" | "generating" | "delivering" | "stopping" | "interrupted";
  queuedTurns: number;
  /** When the current reply started generating; null while it waits in the queue. */
  startedAt?: number | null;
}

export interface WebThread {
  id: string;
  userId: number;
  title: string;
  archived: boolean;
  parentThreadId: string | null;
  forkPointMessageId: number | null;
  lastActivity: number;
  activity: WebThreadActivity | null;
}

export interface WebAttachment {
  id: string;
  name: string;
  size: number | null;
  mimeType: string | null;
  caption: string | null;
  kind?: "image" | "audio" | "file";
  description?: string | null;
  transcription?: string | null;
  transcriptionTruncated?: boolean;
}

export interface WebMessage {
  action?: CompactionAction;
  id: number;
  threadId: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking: string | null;
  toolActivity?: ToolActivity;
  createdAt: number;
  attachments: WebAttachment[];
  usage?: WebMessageUsage | null;
  openui?: string | null;
  openuiLanguage?: OpenUiLanguage;
  telegramSyncFailed?: boolean;
  /** Time from the start of generation until this reply was saved, when its turn is known. */
  durationMs?: number | null;
}

export interface WebUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
  cacheReadRatio: number | null;
  recordedTurns: number;
  missingUsageTurns: number;
  unpricedTurns: number;
  estimatedCostUsd: number | null;
  fastModeCalls: number;
  standardModeCalls: number;
  unknownFastModeCalls: number;
  cacheReadReportedCalls: number;
  cacheWriteReportedCalls: number;
  cacheReadUnreportedCalls: number;
  cacheWriteUnreportedCalls: number;
  /** Legacy aggregates count as one usage record; their exact call count is unknown. */
  aggregateUsageEntries: number;
}

export interface WebModelUsage extends WebUsageTotals { provider: string; model: string }
export interface WebMessageUsage extends WebUsageTotals {
  models: WebModelUsage[];
  modelCalls: number | null;
  calls?: InferenceUsageCall[];
}
export interface WebUsageReport {
  user?: Pick<WebUser, "id" | "name" | "username"> | null;
  totals: WebUsageTotals;
  dailyTruncated: boolean;
  daily: (WebUsageTotals & { date: string })[];
  models: WebModelUsage[];
  threads: (WebUsageTotals & { id: string; userId: number; title: string; archived: boolean })[];
  pricing: { source: "LiteLLM"; fetchedAt: number | null; stale: boolean };
  since: number | null;
  until: number;
}

export interface WebPage<T> { items: T[]; nextOffset: number | null }
export interface WebHistory {
  user: WebUser;
  thread: WebThread;
  chain: Pick<WebThread, "id" | "title" | "parentThreadId" | "forkPointMessageId">[];
  messages: WebMessage[];
  olderCursor: number | null;
  newerCursor: number | null;
  autoLoadMaxBytes: number;
  maxFileBytes: number;
}
