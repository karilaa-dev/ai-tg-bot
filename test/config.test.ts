import { describe, expect, it } from "vitest";
import { isBrowserUseConfigured, loadConfig } from "../src/config.js";

const required = {
  BOT_TOKEN: "TEST:TOKEN",
  OPENROUTER_API_KEY: "test-openrouter",
  TAVILY_API_KEY: "test-tavily",
  E2B_API_KEY: "test-e2b",
};

describe("Browser Use configuration", () => {
  it("accepts an explicit Codex CLI credential cache path", () => {
    expect(loadConfig({ ...required, CODEX_AUTH_FILE: "/run/secrets/codex-auth.json" }).CODEX_AUTH_FILE)
      .toBe("/run/secrets/codex-auth.json");
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

describe("database configuration", () => {
  it("URL-encodes the Compose PostgreSQL password", () => {
    const config = loadConfig({
      ...required,
      POSTGRES_PASSWORD: "complex:/?#[]@!$&'()*+,;=% password",
    });

    expect(config.DB_URL).toBe(
      "postgres://aibot:complex%3A%2F%3F%23%5B%5D%40!%24%26'()*%2B%2C%3B%3D%25%20password@postgres:5432/aibot",
    );
  });

  it("preserves an explicit external database URL", () => {
    const databaseUrl = "postgresql://dokploy:secret@dokploy-postgres:5432/aibot";
    const config = loadConfig({
      ...required,
      DB_URL: databaseUrl,
      POSTGRES_PASSWORD: "compose-only",
    });

    expect(config.DB_URL).toBe(databaseUrl);
  });

  it.each([
    undefined,
    "sqlite:/app/data/bot.db",
    "sqlite:./data/bot.db",
  ])("uses Compose PostgreSQL when DB_URL is %s", (databaseUrl) => {
    const config = loadConfig({
      ...required,
      ...(databaseUrl === undefined ? {} : { DB_URL: databaseUrl }),
      POSTGRES_PASSWORD: "compose-password",
    });

    expect(config.DB_URL).toBe("postgres://aibot:compose-password@postgres:5432/aibot");
  });
});
