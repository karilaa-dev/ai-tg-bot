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
