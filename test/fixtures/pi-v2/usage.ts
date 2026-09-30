import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

export interface InferenceUsageCall {
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

type UsageSource = Pick<AssistantMessage, "provider" | "model" | "responseModel" | "usage"> & { aggregate?: boolean };

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
  const calls: InferenceUsageCall[] = messages.map(({ provider, model, responseModel, usage, aggregate }) => ({
    provider, model: responseModel ?? model,
    inputTokens: usage.input, outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    cacheWrite1hTokens: usage.cacheWrite1h, reasoningTokens: usage.reasoning,
    cost: usage.cost,
    ...(aggregate ? { aggregate: true } : {}),
  }));
  const total = messages.reduce((sum, { usage }) => ({
    input: sum.input + usage.input, output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite, total: 0,
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
