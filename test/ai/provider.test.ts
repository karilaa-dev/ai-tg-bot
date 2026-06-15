import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { getContextBudget } from "../../src/ai/provider.js";

describe("OpenRouter provider helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches resolved model context length by model id", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        data: [
          { id: "cache-model-a", context_length: 12345 },
          { id: "cache-model-b", top_provider: { context_length: 67890 } },
        ],
      }), { status: 200 });
    }));

    const a = loadTestConfig({ MODEL_CONTEXT_TOKENS_OVERRIDE: undefined, OPENROUTER_MODEL: "cache-model-a" });
    const b = loadTestConfig({ MODEL_CONTEXT_TOKENS_OVERRIDE: undefined, OPENROUTER_MODEL: "cache-model-b" });

    await expect(getContextBudget(a)).resolves.toBe(12345);
    await expect(getContextBudget(a)).resolves.toBe(12345);
    expect(fetches).toBe(1);
    await expect(getContextBudget(b)).resolves.toBe(67890);
    expect(fetches).toBe(2);
  });
});
