import { describe, expect, it } from "vitest";
import { inferenceUsageDelta, type TokenTotals } from "../../src/pi/usage.js";

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
