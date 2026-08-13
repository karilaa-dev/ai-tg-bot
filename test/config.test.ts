import { describe, expect, it } from "vitest";
import { isBrowserUseConfigured, loadConfig } from "../src/config.js";

const required = {
  BOT_TOKEN: "TEST:TOKEN",
  OPENROUTER_API_KEY: "test-openrouter",
  TAVILY_API_KEY: "test-tavily",
  E2B_API_KEY: "test-e2b",
};

describe("Browser Use configuration", () => {
  it("accepts an optional one-time upgrade baseline path", () => {
    expect(loadConfig({ ...required, UPGRADE_BASELINE_FILE: "/app/data/pi/upgrade-baseline.json" }).UPGRADE_BASELINE_FILE)
      .toBe("/app/data/pi/upgrade-baseline.json");
  });

  it("leaves Browser Use disabled and defaults to a five-minute session", () => {
    const config = loadConfig(required);
    expect(config.E2B_TEMPLATE).toBe("ai-tg-bot-tools:production");
    expect(config.E2B_FILE_SOURCE_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(config.BROWSER_USE_DEFAULT_TIMEOUT_MINUTES).toBe(5);
    expect(config.BROWSER_USE_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(isBrowserUseConfigured(config)).toBe(false);
  });

  it("enables Browser Use with only an API key", () => {
    const config = loadConfig({
      ...required,
      BROWSER_USE_API_KEY: "secret",
    });
    expect(isBrowserUseConfigured(config)).toBe(true);
    expect(config.BROWSER_USE_API_TIMEOUT_MS).toBe(30_000);
  });

  it("bounds agent-selectable cloud timeouts", () => {
    expect(() => loadConfig({ ...required, BROWSER_USE_DEFAULT_TIMEOUT_MINUTES: "4" })).toThrow();
    expect(() => loadConfig({ ...required, BROWSER_USE_DEFAULT_TIMEOUT_MINUTES: "241" })).toThrow();
  });
});
