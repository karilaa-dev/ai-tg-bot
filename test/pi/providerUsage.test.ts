import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderUsageCapture, normalizeProviderUsage } from "../../src/pi/providerUsage.js";
import { InferenceUsageCollector } from "../../src/pi/usage.js";

describe("provider usage normalization", () => {
  it("keeps OpenRouter input inclusive when native Anthropic aliases appear beside prompt totals", () => {
    expect(normalizeProviderUsage({
      prompt_tokens: 1_000, completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 },
      cache_creation_input_tokens: 200,
    })?.usage).toMatchObject({ input: 100, cacheRead: 700, cacheWrite: 200, output: 40, totalTokens: 1_040 });
  });

  it("keeps native Anthropic cache counters separate and caps subsets", () => {
    expect(normalizeProviderUsage({
      input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 700, cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_1h_input_tokens: 500 }, output_tokens_details: { reasoning_tokens: 500 },
    })?.usage).toMatchObject({ input: 100, cacheRead: 700, cacheWrite: 200, output: 40, totalTokens: 1_040, cacheWrite1h: 200, reasoning: 40 });
  });

  it("rejects malformed token counters but retains fractional reported monetary cost", () => {
    const result = normalizeProviderUsage({ input_tokens: 100, output_tokens: 20,
      input_tokens_details: { cached_tokens: 0.5, cache_write_tokens: Number.MAX_SAFE_INTEGER + 1 }, cost: 0.0123 });
    expect(result).toMatchObject({
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, cost: { total: 0.0123 } },
      cacheReadReported: false, cacheWriteReported: false, costReported: true,
    });
  });

  it("records a response once, prefers reported cost and captures only its terminal tier", async () => {
    const collector = new InferenceUsageCollector();
    const capture = new ProviderUsageCapture("openrouter", "model", { fastMode: false });
    const message = { provider: "openrouter", model: "model", usage: {
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
      cost: { input: 0.4, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.8 },
    } } as AssistantMessage;
    await collector.run(async () => {
      capture.observe({ type: "response.created", response: { service_tier: "priority", usage: { input_tokens: 500 } } });
      capture.observe({ type: "response.completed", response: { service_tier: "default", usage: { input_tokens: 100, output_tokens: 20, cost: 0.0123 } } });
      capture.record(message);
      capture.record();
    });
    expect(collector.usage().calls).toMatchObject([{ serviceTier: "default", inputTokens: 100, cost: { total: 0.0123 } }]);
    expect(collector.usage().calls).toHaveLength(1);
    expect(message.usage.cost.total).toBe(0.0123);
  });
});
