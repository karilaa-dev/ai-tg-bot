import { describe, expect, it, vi } from "vitest";
import { estimateCallCost, UsagePricing, type PricingCatalog } from "../../src/web/usage-pricing.js";
import { summarizeUsage } from "../../src/web/usage.js";
import type { InferenceUsageCall } from "../../src/pi/usage.js";

const rates = {
  input_cost_per_token: 2 / 1e6, output_cost_per_token: 10 / 1e6,
  cache_read_input_token_cost: 0.2 / 1e6, cache_creation_input_token_cost: 2.5 / 1e6,
};
const catalog: PricingCatalog = { "gpt-test": rates };
const call: InferenceUsageCall = { provider: "openai-codex", model: "gpt-test", inputTokens: 1_000_000,
  outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000, reasoningTokens: 50_000 };

describe("ccusage token pricing", () => {
  it("prices disjoint categories and does not add reasoning to output", () => {
    expect(estimateCallCost(call, catalog)).toBeCloseTo(3.35);
    const summary = summarizeUsage({ usage: JSON.stringify({ ...call, calls: [call] }), provider: call.provider, model: call.model }, catalog);
    expect(summary).toMatchObject({ totalTokens: 1_700_000, reasoningTokens: 50_000, modelCalls: 1 });
    expect(summary.cacheReadRatio).toBeCloseTo(500_000 / 1_600_000);
  });

  it("prefers provider-specific prices and supports Codex and OpenRouter model IDs", () => {
    expect(estimateCallCost({ ...call, model: "openai-codex/gpt-test" }, catalog)).toBeCloseTo(3.35);
    expect(estimateCallCost({ ...call, provider: "openrouter", model: "openai/gpt-test" }, catalog)).toBeCloseTo(3.35);
    expect(estimateCallCost({ ...call, provider: "openrouter", model: "openai/gpt-test" }, {
      ...catalog, "openrouter/openai/gpt-test": { ...rates, input_cost_per_token: 4 / 1e6 },
    })).toBeCloseTo(5.35);
  });

  it("uses the context tier per call and the one-hour write rate, not the sum of a turn's prompts", () => {
    const prices = { "claude-test": { ...rates, input_cost_per_token_above_200k_tokens: 4 / 1e6,
      output_cost_per_token_above_200k_tokens: 20 / 1e6, cache_read_input_token_cost_above_200k_tokens: 0.4 / 1e6,
      cache_creation_input_token_cost_above_200k_tokens: 5 / 1e6 } };
    const claude = { ...call, provider: "anthropic", model: "claude-test", cacheWrite1hTokens: 50_000 };
    expect(estimateCallCost(claude, prices)).toBeCloseTo(6.85);
    expect(estimateCallCost(claude, prices, false)).toBeCloseTo(3.425);
    expect(estimateCallCost({ ...claude, inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }, prices)).toBeCloseTo(0.22);
  });

  it("does not show unknown models or missing cache prices as free", () => {
    expect(estimateCallCost(call, {})).toBeNull();
    expect(estimateCallCost(call, { "gpt-test": { input_cost_per_token: 1, output_cost_per_token: 1 } })).toBeNull();
    expect(estimateCallCost({ ...call, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, {})).toBeNull();
    expect(estimateCallCost({ ...call, cost: { input: 2, output: 1, cacheRead: 0.1, cacheWrite: 0.25, total: 3.35 } }, {})).toBe(3.35);
    expect(estimateCallCost(call, { "gpt-test": { input_cost_per_token: 0, output_cost_per_token: 0, cache_read_input_token_cost: 0, cache_creation_input_token_cost: 0 } })).toBe(0);
  });

  it("keeps separate models, partial costs, and unavailable historical reasoning", () => {
    const other = { ...call, provider: "other", model: "unknown", reasoningTokens: undefined };
    const summary = summarizeUsage({ usage: JSON.stringify({ inputTokens: 2_000_000, outputTokens: 200_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000, calls: [call, other] }), provider: "other", model: "unknown" }, catalog);
    expect(summary).toMatchObject({ recordedTurns: 1, unpricedTurns: 1, modelCalls: 2, totalTokens: 3_400_000 });
    expect(summary.models).toHaveLength(2);
    expect(summary.estimatedCostUsd).toBeCloseTo(3.35);
    expect(summarizeUsage({ usage: JSON.stringify(call), provider: call.provider, model: call.model }, catalog)).toMatchObject({ modelCalls: null, reasoningTokens: null });
  });

  it.each([null, "broken", "null", "{}", '{"inputTokens":-1,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}'])("handles missing or corrupt historical counters: %s", usage => {
    expect(summarizeUsage({ usage, provider: "openai", model: "gpt-test" }, catalog)).toMatchObject({
      missingUsageTurns: 1, recordedTurns: 0, totalTokens: 0, estimatedCostUsd: null,
    });
  });
});

it("shares pricing downloads, refreshes daily, retains stale data, and backs off failures", async () => {
  let now = 1_000;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog));
  const pricing = new UsagePricing(fetcher, () => now);
  const [first, second] = await Promise.all([pricing.load(), pricing.load()]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(first).toEqual(second);
  expect(first).toMatchObject({ catalog, fetchedAt: 1_000, stale: false });
  await pricing.load();
  expect(fetcher).toHaveBeenCalledOnce();
  now += 86_400_000;
  fetcher.mockResolvedValueOnce(Response.json({ error: "bad data" }));
  expect(await pricing.load()).toMatchObject({ catalog, fetchedAt: 1_000, stale: true });
  await pricing.load();
  expect(fetcher).toHaveBeenCalledTimes(2);
  now += 300_000;
  fetcher.mockResolvedValueOnce(Response.json(catalog));
  expect(await pricing.load()).toMatchObject({ fetchedAt: now, stale: false });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
