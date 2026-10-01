import { describe, expect, it, vi } from "vitest";
import { estimateCallCost, MAX_PRICING_BYTES, UsagePricing, type PricingCatalog } from "../../src/web/usage-pricing.js";
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

  it("prices recorded priority calls using cached-token priority rates", () => {
    const priority = { ...call, cacheWriteTokens: 0, serviceTier: "priority" };
    const prices = { "gpt-test": { ...rates, input_cost_per_token_priority: 4 / 1e6,
      output_cost_per_token_priority: 20 / 1e6, cache_read_input_token_cost_priority: 0.4 / 1e6 } };
    expect(estimateCallCost(priority, prices)).toBeCloseTo(6.2);
  });

  it("uses delivered tiers before requested tiers and estimates an undelivered requested tier", () => {
    const prices = { "gpt-test": { ...rates, input_cost_per_token_priority: 4 / 1e6,
      output_cost_per_token_priority: 20 / 1e6, cache_read_input_token_cost_priority: 0.4 / 1e6,
      input_cost_per_token_flex: 1 / 1e6, output_cost_per_token_flex: 5 / 1e6, cache_read_input_token_cost_flex: 0.1 / 1e6 } };
    const requested = { ...call, cacheWriteTokens: 0, fastMode: true, requestedServiceTier: "priority" };
    expect(estimateCallCost(requested, prices)).toBeCloseTo(6.2);
    expect(estimateCallCost({ ...requested, serviceTier: "default" }, prices)).toBeCloseTo(3.1);
    expect(estimateCallCost({ ...requested, serviceTier: "flex" }, prices)).toBeCloseTo(1.55);
    expect(estimateCallCost({ ...call, cacheWriteTokens: 0 }, prices)).toBeCloseTo(3.1);
  });

  it("uses combined context and priority rates and leaves missing tier rates unpriced", () => {
    const priority = { ...call, cacheWriteTokens: 0, serviceTier: "priority" };
    const base = { ...rates, input_cost_per_token_priority: 4 / 1e6,
      output_cost_per_token_priority: 20 / 1e6, cache_read_input_token_cost_priority: 0.4 / 1e6,
      input_cost_per_token_above_272k_tokens: 4 / 1e6, output_cost_per_token_above_272k_tokens: 20 / 1e6,
      cache_read_input_token_cost_above_272k_tokens: 0.4 / 1e6 };
    expect(estimateCallCost(priority, { "gpt-test": base })).toBeNull();
    expect(estimateCallCost(priority, { "gpt-test": { ...base, input_cost_per_token_above_272k_tokens_priority: 8 / 1e6,
      output_cost_per_token_above_272k_tokens_priority: 40 / 1e6, cache_read_input_token_cost_above_272k_tokens_priority: 0.8 / 1e6 } })).toBeCloseTo(12.4);
    expect(estimateCallCost(priority, catalog)).toBeNull();
    expect(estimateCallCost({ ...priority, cost: { input: 4, output: 2, cacheRead: 0.2, cacheWrite: 0, total: 6.2 } }, catalog)).toBeCloseTo(6.2);
  });

  it("does not trust standard SDK costs when a requested priority tier was never reported", () => {
    const requested = { ...call, cacheWriteTokens: 0, requestedServiceTier: "priority",
      cost: { input: 2, output: 1, cacheRead: 0.1, cacheWrite: 0, total: 3.1 } };
    expect(estimateCallCost(requested, catalog)).toBeNull();
    expect(estimateCallCost(requested, {})).toBeNull();
    expect(estimateCallCost({ ...requested, serviceTier: "default" }, {})).toBeCloseTo(3.1);
    expect(estimateCallCost({ ...requested, serviceTier: "scale" }, {})).toBeNull();
  });

  it("keeps fast-mode and cache-reporting coverage separate from token quantities", () => {
    const fast = { ...call, cacheWriteTokens: 0, fastMode: true, requestedServiceTier: "priority", serviceTier: "default", cacheReadReported: true, cacheWriteReported: false, source: "model" };
    const standard = { ...call, cacheReadTokens: 0, cacheWriteTokens: 0, fastMode: false, cacheReadReported: true, cacheWriteReported: true };
    const unknown = { ...call, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const summary = summarizeUsage({ usage: JSON.stringify({ inputTokens: call.inputTokens * 3, outputTokens: call.outputTokens * 3,
      cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: 0, calls: [fast, standard, unknown] }), provider: "unknown", model: "unknown" }, catalog);
    expect(summary).toMatchObject({ fastModeCalls: 1, standardModeCalls: 1, unknownFastModeCalls: 1,
      cacheReadReportedCalls: 2, cacheReadUnreportedCalls: 1, cacheWriteReportedCalls: 1, cacheWriteUnreportedCalls: 2,
      aggregateUsageEntries: 0, cacheReadTokens: 500_000, cacheWriteTokens: 0 });
    expect(summary.calls?.[0]).toMatchObject({ fastMode: true, requestedServiceTier: "priority", serviceTier: "default", cacheWriteReported: false, source: "model" });
    const legacy = summarizeUsage({ usage: JSON.stringify({ ...call, cacheWriteTokens: 0 }), provider: call.provider, model: call.model }, catalog);
    expect(legacy).toMatchObject({ fastModeCalls: 0, standardModeCalls: 0, unknownFastModeCalls: 1, aggregateUsageEntries: 1,
      cacheReadReportedCalls: 1, cacheWriteReportedCalls: 0, cacheWriteUnreportedCalls: 1, modelCalls: null });
    expect(legacy.calls).toBeUndefined();
  });

  it("ignores malformed optional metadata without losing valid calls or exposing unrelated fields", () => {
    const metadata = { ...call, fastMode: "true", serviceTier: "priority".repeat(100), requestedServiceTier: "bad\ntier",
      cacheReadReported: false, cacheWriteReported: null, reasoningTokens: -5, cacheWrite1hTokens: 1_000_000,
      source: "invalid\nsource", privateField: "not-public", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4, secret: "not-public" } };
    const summary = summarizeUsage({ usage: JSON.stringify({ ...call, calls: [metadata] }), provider: "unknown", model: "unknown" }, catalog);
    expect(summary).toMatchObject({ modelCalls: 1, aggregateUsageEntries: 0, cacheReadTokens: 500_000,
      cacheReadReportedCalls: 1, cacheWriteReportedCalls: 1, unknownFastModeCalls: 1 });
    expect(summary.models[0]?.model).toBe(call.model);
    expect(summary.calls?.[0]).not.toHaveProperty("fastMode");
    expect(summary.calls?.[0]).not.toHaveProperty("serviceTier");
    expect(summary.calls?.[0]).not.toHaveProperty("reasoningTokens");
    expect(JSON.stringify(summary)).not.toContain("not-public");
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

  it("does not use a base one-hour cache rate for a long-context call", () => {
    const prices = { "claude-test": { ...rates, input_cost_per_token_above_200k_tokens: 4 / 1e6,
      cache_creation_input_token_cost_above_1hr: 4 / 1e6 } };
    const cached = { ...call, provider: "anthropic", model: "claude-test", inputTokens: 200_000,
      outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100_000, cacheWrite1hTokens: 100_000 };
    expect(estimateCallCost(cached, prices)).toBeCloseTo(1.6);
    expect(estimateCallCost(cached, prices, false)).toBeCloseTo(0.8);
    expect(estimateCallCost({ ...cached, inputTokens: 100_000 }, prices)).toBeCloseTo(0.6);
    expect(estimateCallCost(cached, { "claude-test": { ...prices["claude-test"],
      cache_creation_input_token_cost_above_1hr_above_200k_tokens: 9 / 1e6 } })).toBeCloseTo(1.7);
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

it.each(["declared", "streamed"])("rejects oversized %s pricing responses and retains the last catalog", async mode => {
  let now = 1_000;
  const cancelled = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(catalog));
  const pricing = new UsagePricing(fetcher, () => now);
  await pricing.load();
  now += 86_400_000;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel: cancelled,
  });
  fetcher.mockResolvedValueOnce(new Response(stream, {
    headers: mode === "declared" ? { "content-length": String(MAX_PRICING_BYTES + 1) } : { "content-length": "1" },
  }));
  expect(await pricing.load()).toMatchObject({ catalog, fetchedAt: 1_000, stale: true });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(chunks).toBeLessThanOrEqual(mode === "declared" ? 1 : MAX_PRICING_BYTES / (1024 * 1024) + 2);
  await pricing.load();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
