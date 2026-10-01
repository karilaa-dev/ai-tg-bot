import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface InferenceUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheReadRatio: number | null;
  /** Per-call counts retain model switches and context pricing tiers. */
  calls?: InferenceUsageCall[];
}

export interface InferenceUsageMetadata {
  /** Whether this request used the bot's Codex fast-mode setting. Absent in older records. */
  fastMode?: boolean;
  requestedServiceTier?: string;
  /** The tier returned by the provider, which can differ from the requested tier. */
  serviceTier?: string;
  cacheReadReported?: boolean;
  cacheWriteReported?: boolean;
  source?: string;
}

export interface InferenceUsageCall extends InferenceUsageMetadata {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  /** Included in outputTokens, never added to the total again. */
  reasoningTokens?: number;
  cost?: AssistantMessage["usage"]["cost"];
  /** Summaries/tools may report multiple calls without model attribution. */
  aggregate?: boolean;
}

export type UsageSource = Pick<AssistantMessage, "provider" | "model" | "responseModel" | "usage">
  & InferenceUsageMetadata & { aggregate?: boolean };

const activeUsage = new AsyncLocalStorage<InferenceUsageCollector>();

/** Captures provider calls even if a failed attempt or summary never becomes a session entry. */
export class InferenceUsageCollector {
  private readonly calls: InferenceUsageCall[] = [];
  private closed = false;

  run<T>(work: () => Promise<T>): Promise<T> {
    return activeUsage.run(this, async () => {
      try { return await work(); }
      finally { this.closed = true; }
    });
  }

  record(source: UsageSource): void {
    if (!this.closed) this.calls.push(usageCall(source));
  }

  usage(): InferenceUsageDelta {
    return inferenceUsageFromCalls(this.calls.map(call => ({ ...call, cost: call.cost && { ...call.cost } })));
  }
}

/** Call once per provider request, before forwarding its terminal message to the session. */
export function recordInferenceUsage(source: UsageSource, metadata: InferenceUsageMetadata = {}): void {
  Object.assign(source, metadata);
  activeUsage.getStore()?.record(source);
}

export function inferenceUsageFromEntries(entries: SessionEntry[]): InferenceUsageDelta {
  const sources = entries.flatMap<UsageSource>(entry => {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) return [entry.message];
    const usage = entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
      : entry.type === "message" && entry.message.role === "toolResult" ? entry.message.usage : undefined;
    return usage ? [{ provider: "unknown", model: entry.type === "message" ? "Unattributed tool usage" : "Context summaries", usage, aggregate: true }] : [];
  });
  return inferenceUsageFromMessages(sources);
}

export function inferenceUsageFromMessages(messages: UsageSource[]): InferenceUsageDelta {
  return inferenceUsageFromCalls(messages.map(usageCall));
}

function usageCall({ provider, model, responseModel, usage, aggregate,
  fastMode, requestedServiceTier, serviceTier, cacheReadReported, cacheWriteReported, source }: UsageSource): InferenceUsageCall {
  return {
    provider, model: responseModel ?? model,
    inputTokens: usage.input, outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    cacheWrite1hTokens: usage.cacheWrite1h, reasoningTokens: usage.reasoning,
    cost: { ...usage.cost },
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(requestedServiceTier !== undefined ? { requestedServiceTier } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(cacheReadReported !== undefined ? { cacheReadReported } : {}),
    ...(cacheWriteReported !== undefined ? { cacheWriteReported } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(aggregate ? { aggregate: true } : {}),
  };
}

function inferenceUsageFromCalls(calls: InferenceUsageCall[]): InferenceUsageDelta {
  const total = calls.reduce((sum, call) => ({
    input: sum.input + call.inputTokens, output: sum.output + call.outputTokens,
    cacheRead: sum.cacheRead + call.cacheReadTokens, cacheWrite: sum.cacheWrite + call.cacheWriteTokens, total: 0,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  return { ...inferenceUsageDelta({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, total), calls };
}

export function inferenceUsageDelta(
  before: TokenTotals,
  after: TokenTotals,
): InferenceUsageDelta {
  const inputTokens = nonNegativeDelta(before.input, after.input);
  const outputTokens = nonNegativeDelta(before.output, after.output);
  const cacheReadTokens = nonNegativeDelta(before.cacheRead, after.cacheRead);
  const cacheWriteTokens = nonNegativeDelta(before.cacheWrite, after.cacheWrite);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cacheReadRatio: promptTokens > 0
      ? Math.round((cacheReadTokens / promptTokens) * 10_000) / 10_000
      : null,
  };
}

function nonNegativeDelta(before: number, after: number): number {
  return Math.max(0, after - before);
}
