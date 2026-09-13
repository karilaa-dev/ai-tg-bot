import { describe, expect, it } from "vitest";
import { inferenceUsageDelta, inferenceUsageFromMessages, inferenceUsageFromEntries, type TokenTotals } from "../../src/pi/usage.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

it("includes tool and compaction usage without assigning them to the reply's model", () => {
  const usage = { input: 100, output: 30, cacheRead: 200, cacheWrite: 20, totalTokens: 350,
    cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1, total: 0.4 } };
  const result = inferenceUsageFromEntries([
    { type: "message", message: { role: "assistant", provider: "openai", model: "alias", responseModel: "actual-model", usage } },
    { type: "compaction", usage },
    { type: "branch_summary", usage },
    { type: "message", message: { role: "toolResult", usage } },
    { type: "message", message: { role: "toolResult" } },
  ] as SessionEntry[]);
  expect(result.totalTokens).toBe(1_400);
  expect(result.calls?.map(call => call.model)).toEqual(["actual-model", "Context summaries", "Context summaries", "Unattributed tool usage"]);
  expect(result.calls?.slice(1).every(call => call.aggregate && call.provider === "unknown" && call.cost?.total === 0.4)).toBe(true);
});

it("preserves each model call, reasoning and one-hour cache writes in a turn", () => {
  const messages = ["first", "fallback"].map(model => ({
    model, provider: "test", usage: { input: 100, output: 30, cacheRead: 200, cacheWrite: 20,
      cacheWrite1h: 10, reasoning: 12, totalTokens: 350, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  })) as AssistantMessage[];
  const usage = inferenceUsageFromMessages(messages);
  expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 60, cacheReadTokens: 400, cacheWriteTokens: 40, totalTokens: 700 });
  expect(usage.calls?.map(call => [call.model, call.reasoningTokens, call.cacheWrite1hTokens])).toEqual([["first", 12, 10], ["fallback", 12, 10]]);
});

describe("inferenceUsageDelta", () => {
  it("calculates normal positive deltas and the cache-read ratio", () => {
    expect(inferenceUsageDelta(
      totals(100, 20, 400, 10, 530),
      totals(300, 70, 1_200, 10, 1_580),
    )).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      totalTokens: 1_050,
      cacheReadRatio: 0.8,
    });
  });

  it("includes cache writes in the prompt-token denominator and rounds to four decimals", () => {
    expect(inferenceUsageDelta(
      totals(0, 0, 0, 0, 0),
      totals(2, 1, 2, 3, 8),
    )).toMatchObject({
      totalTokens: 8,
      cacheReadRatio: 0.2857,
    });
  });

  it("returns null when no prompt tokens were consumed", () => {
    expect(inferenceUsageDelta(
      totals(4, 2, 3, 1, 10),
      totals(4, 7, 3, 1, 15),
    )).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 5,
      cacheReadRatio: null,
    });
  });

  it("clamps reset or malformed cumulative counters to non-negative deltas", () => {
    expect(inferenceUsageDelta(
      totals(10, 20, 30, 40, 100),
      totals(5, 10, 15, 20, 50),
    )).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cacheReadRatio: null,
    });
  });
});

function totals(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
): TokenTotals {
  return { input, output, cacheRead, cacheWrite, total };
}
