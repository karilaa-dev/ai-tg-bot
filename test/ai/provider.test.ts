import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadTestConfig } from "../../src/config.js";
import { embed, getContextBudget } from "../../src/ai/provider.js";

describe("Codex provider helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a fixed Codex context default without fetching model metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getContextBudget(loadTestConfig())).resolves.toBe(128000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults Codex turns to Sol with medium detailed reasoning on the fast service tier", () => {
    const config = loadTestConfig();

    expect(config.CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(config.CODEX_SPEED_MODE).toBe("fast");
    expect(config.REASONING_EFFORT).toBe("medium");
    expect(config.REASONING_SUMMARY).toBe("detailed");
  });

  it("posts embedding requests to OpenRouter only for vectors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { embedding: [1, 2, 3] },
        { embedding: [4, 5, 6] },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadTestConfig({ OPENROUTER_EMBEDDING_MODEL: "embedding-model" });

    const vectors = await embed(["a", "b"], config);

    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/embeddings", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: "embedding-model", input: ["a", "b"] }),
    }),);
    expect(vectors.map((vector) => Array.from(vector))).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("loads Codex env fields", () => {
    const config = loadConfig({
      BOT_TOKEN: "TEST:TOKEN",
      TELEGRAM_ADMIN_ID: "1000",
      DB_URL: "sqlite::memory:",
      CODEX_MODEL: "gpt-5.6-terra",
      CODEX_COMPACTION_MODEL: "gpt-5.4-mini",
      CODEX_SPEED_MODE: "standard",
      CODEX_VERBOSITY: "high",
      REASONING_EFFORT: "high",
      REASONING_SUMMARY: "concise",
      STREAM_DELTA_CHARS: "24",
      OPENROUTER_API_KEY: "test-openrouter",
      OPENROUTER_EMBEDDING_MODEL: "perplexity/pplx-embed-v1-0.6b",
      TAVILY_API_KEY: "test-tavily",
    });

    expect(config.CODEX_MODEL).toBe("gpt-5.6-terra");
    expect(config.CODEX_COMPACTION_MODEL).toBe("gpt-5.4-mini");
    expect(config.CODEX_IMAGE_MODEL).toBe("gpt-image-2");
    expect(config.CODEX_IMAGE_QUALITY).toBe("low");
    expect(config.CODEX_IMAGE_TIMEOUT_MS).toBe(300_000);
    expect(config.CODEX_SPEED_MODE).toBe("standard");
    expect(config.CODEX_VERBOSITY).toBe("high");
    expect(config.REASONING_EFFORT).toBe("high");
    expect(config.REASONING_SUMMARY).toBe("concise");
    expect(config.STREAM_DELTA_CHARS).toBe(24);
  });
});
