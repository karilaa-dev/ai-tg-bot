import { describe, expect, it } from "vitest";
import { isBrowserUseConfigured, loadConfig } from "../src/config.js";
import { APP_VERSION } from "../src/version.js";

const required = {
  BOT_TOKEN: "TEST:TOKEN",
  OPENROUTER_API_KEY: "test-openrouter",
  TAVILY_API_KEY: "test-tavily",
  E2B_API_KEY: "test-e2b",
};

describe("website access configuration", () => {
  it("requires an admin token only when the website is enabled", () => {
    expect(loadConfig(required).WEB_ADMIN_TOKEN).toBeUndefined();
    expect(loadConfig({ ...required, WEB_ENABLED: "false", WEB_ADMIN_TOKEN: " " }).WEB_ADMIN_TOKEN).toBeUndefined();
    for (const token of [undefined, "", " \n "]) {
      expect(() => loadConfig({ ...required, WEB_ENABLED: "true", WEB_ADMIN_TOKEN: token })).toThrow("WEB_ADMIN_TOKEN");
    }
    expect(loadConfig({ ...required, WEB_ENABLED: "true", WEB_ADMIN_TOKEN: " test-secret " }).WEB_ADMIN_TOKEN).toBe("test-secret");
    expect(() => loadConfig({ ...required, WEB_ENABLED: "true", WEB_ADMIN_TOKEN: "x".repeat(1025) })).toThrow("WEB_ADMIN_TOKEN");
  });
});

describe("Codex server tools configuration", () => {
  it("enables server compaction and automatic search without a Tavily key", () => {
    const config = loadConfig({ ...required, TAVILY_API_KEY: " " });
    expect(config.TAVILY_API_KEY).toBeUndefined();
    expect(config.WEB_SEARCH_PROVIDER).toBe("auto");
    expect(config.CODEX_WEB_SEARCH_MODE).toBe("live");
    expect(loadConfig({ ...required, CODEX_WEB_SEARCH_MODE: "cached" }).CODEX_WEB_SEARCH_MODE).toBe("cached");
    expect(config.CODEX_SERVER_COMPACTION).toBe(true);
    expect(loadConfig({ ...required, CODEX_SERVER_COMPACTION: "false" }).CODEX_SERVER_COMPACTION).toBe(false);
  });
  it("rejects unsupported providers and invalid compaction switches", () => {
    expect(() => loadConfig({ ...required, WEB_SEARCH_PROVIDER: "unknown" })).toThrow();
    expect(() => loadConfig({ ...required, CODEX_WEB_SEARCH_MODE: "unknown" })).toThrow();
    expect(() => loadConfig({ ...required, CODEX_SERVER_COMPACTION: "1" })).toThrow();
  });
});

describe("Codex fast mode configuration", () => {
  it("defaults to disabled and accepts explicit true or false", () => {
    expect(loadConfig(required).CODEX_FAST_MODE).toBe(false);
    expect(loadConfig({ ...required, CODEX_FAST_MODE: "true" }).CODEX_FAST_MODE).toBe(true);
    expect(loadConfig({ ...required, CODEX_FAST_MODE: "false" }).CODEX_FAST_MODE).toBe(false);
  });

  it("rejects invalid boolean values", () => {
    expect(() => loadConfig({ ...required, CODEX_FAST_MODE: "invalid" })).toThrow();
  });
});

describe("Browser Use configuration", () => {
  it("derives the E2B template from the app version and accepts an override", () => {
    expect(loadConfig(required).E2B_TEMPLATE).toBe(`ai-tg-bot-tools:v${APP_VERSION}`);
    expect(loadConfig({ ...required, E2B_TEMPLATE: "ai-tg-bot-tools:rollback-v1" }).E2B_TEMPLATE)
      .toBe("ai-tg-bot-tools:rollback-v1");
  });

  it("enables Browser Use only when an API key is configured", () => {
    const config = loadConfig({
      ...required,
      BROWSER_USE_API_KEY: "secret",
    });
    expect(isBrowserUseConfigured(loadConfig(required))).toBe(false);
    expect(isBrowserUseConfigured(config)).toBe(true);
  });

  it("bounds agent-selectable cloud timeouts", () => {
    expect(() => loadConfig({ ...required, BROWSER_USE_DEFAULT_TIMEOUT_MINUTES: "4" })).toThrow();
    expect(() => loadConfig({ ...required, BROWSER_USE_DEFAULT_TIMEOUT_MINUTES: "241" })).toThrow();
  });
});

describe("agent execution limits", () => {
  const names = ["PI_TURN_TIMEOUT_MS", "PI_MAX_MODEL_CYCLES", "PI_MAX_TOOL_CALLS", "PI_MAX_CONSECUTIVE_TOOL_FAILURES", "PI_MAX_IDENTICAL_TOOL_FAILURES"] as const;

  it("keeps a separately configurable provider request deadline", () => {
    expect(loadConfig(required).PI_REQUEST_TIMEOUT_MS).toBe(900_000);
    expect(loadConfig({ ...required, PI_REQUEST_TIMEOUT_MS: "60000" }).PI_REQUEST_TIMEOUT_MS).toBe(60_000);
    for (const value of ["0", "-1", "1.5", "Infinity", "invalid"]) {
      expect(() => loadConfig({ ...required, PI_REQUEST_TIMEOUT_MS: value })).toThrow();
    }
  });

  it("keeps a finite recovery grace period for legacy ownerless turns", () => {
    expect(loadConfig(required).LEGACY_TURN_RECOVERY_GRACE_MS).toBe(960_000);
    expect(loadConfig({ ...required, LEGACY_TURN_RECOVERY_GRACE_MS: "120000" }).LEGACY_TURN_RECOVERY_GRACE_MS).toBe(120_000);
    for (const value of ["0", "-1", "1.5", "Infinity", "invalid"]) {
      expect(() => loadConfig({ ...required, LEGACY_TURN_RECOVERY_GRACE_MS: value })).toThrow();
    }
  });

  it.each(names)("accepts a positive cap or explicit unlimited value for %s", (name) => {
    expect(loadConfig({ ...required, [name]: "17" })[name]).toBe(17);
    expect(loadConfig({ ...required, [name]: "0" })[name]).toBe(0);
  });

  it.each(names)("rejects invalid values for %s", (name) => {
    for (const value of ["-1", "1.5", "Infinity", "invalid"]) {
      expect(() => loadConfig({ ...required, [name]: value })).toThrow();
    }
  });
});

describe("transcription configuration", () => {
  it("defaults to Qwen3-ASR-1.7B and supports an override", () => {
    expect(loadConfig(required)).toMatchObject({ OPENROUTER_TRANSCRIPTION_MODEL: "qwen/qwen3-asr-1.7b", TRANSCRIPTION_TIMEOUT_MS: 120_000 });
    expect(loadConfig({ ...required, OPENROUTER_TRANSCRIPTION_MODEL: "vendor/stt", TRANSCRIPTION_TIMEOUT_MS: "60000" }))
      .toMatchObject({ OPENROUTER_TRANSCRIPTION_MODEL: "vendor/stt", TRANSCRIPTION_TIMEOUT_MS: 60_000 });
  });

  it("rejects an empty model and unbounded timeout", () => {
    expect(() => loadConfig({ ...required, OPENROUTER_TRANSCRIPTION_MODEL: " " })).toThrow();
    expect(() => loadConfig({ ...required, TRANSCRIPTION_TIMEOUT_MS: "0" })).toThrow();
  });
});
