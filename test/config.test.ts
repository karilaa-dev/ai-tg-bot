import { describe, expect, it } from "vitest";
import { isCamofoxConfigured, loadConfig } from "../src/config.js";

const required = {
  BOT_TOKEN: "TEST:TOKEN",
  OPENROUTER_API_KEY: "test-openrouter",
  TAVILY_API_KEY: "test-tavily",
  E2B_API_KEY: "test-e2b",
};

describe("Camofox configuration", () => {
  it("defaults web extraction to Tavily and leaves Camofox disabled", () => {
    const config = loadConfig(required);
    expect(config.WEB_EXTRACT_PROVIDER).toBe("tavily");
    expect(config.E2B_TEMPLATE).toBe("ai-tg-bot-tools:production");
    expect(isCamofoxConfigured(config)).toBe(false);
  });

  it("accepts an authenticated HTTP origin and Camofox extraction", () => {
    const config = loadConfig({
      ...required,
      WEB_EXTRACT_PROVIDER: "camofox",
      CAMOFOX_URL: "http://192.168.1.108:9377",
      CAMOFOX_ACCESS_KEY: "secret",
    });
    expect(isCamofoxConfigured(config)).toBe(true);
    expect(config.CAMOFOX_TIMEOUT_MS).toBe(30_000);
  });

  it("requires paired credentials and an exact server origin", () => {
    expect(() => loadConfig({ ...required, CAMOFOX_URL: "https://browser.example" }))
      .toThrow("CAMOFOX_URL and CAMOFOX_ACCESS_KEY must be configured together");
    expect(() => loadConfig({
      ...required,
      CAMOFOX_URL: "https://browser.example/api",
      CAMOFOX_ACCESS_KEY: "secret",
    })).toThrow("must contain only the server origin");
    expect(() => loadConfig({
      ...required,
      CAMOFOX_URL: "not a URL",
      CAMOFOX_ACCESS_KEY: "secret",
    })).toThrow();
    expect(() => loadConfig({ ...required, WEB_EXTRACT_PROVIDER: "camofox" }))
      .toThrow("WEB_EXTRACT_PROVIDER=camofox requires CAMOFOX_URL and CAMOFOX_ACCESS_KEY");
  });
});
