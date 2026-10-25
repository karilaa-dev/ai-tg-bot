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
  it("requires Telegram login only when the website is enabled", () => {
    expect(loadConfig(required).WEB_ENABLED).toBe(false);
    expect(() => loadConfig({ ...required, WEB_ENABLED: "true" })).toThrow("WEB_ENABLED=true requires Telegram login");
    // The retired admin token neither satisfies the requirement nor breaks startup.
    expect(() => loadConfig({ ...required, WEB_ENABLED: "true", WEB_ADMIN_TOKEN: "old-secret" })).toThrow("WEB_ENABLED=true requires Telegram login");
    expect(loadConfig({ ...required, WEB_ADMIN_TOKEN: "old-secret" })).not.toHaveProperty("WEB_ADMIN_TOKEN");
  });
  it("reads admin Telegram IDs and normalizes the canonical origin", () => {
    const config = loadConfig({ ...required, WEB_ENABLED: "true", WEB_TELEGRAM_CLIENT_ID: "123456", WEB_TELEGRAM_CLIENT_SECRET: "dedicated-oauth-secret", WEB_PUBLIC_URL: "https://chat.example/", BOT_ALLOWED_USER_IDS: "123, 456", WEB_ADMIN_USER_IDS: " 456 " });
    expect(config.WEB_ADMIN_USER_IDS).toEqual([456]);
    expect(config.WEB_PUBLIC_URL).toBe("https://chat.example");
    expect(config).not.toHaveProperty("BOT_ALLOWED_USER_IDS");
    expect(loadConfig(required).WEB_ADMIN_USER_IDS).toEqual([]);
    for (const WEB_ADMIN_USER_IDS of ["0", "@karilaa", "1,", "9007199254740992"]) {
      expect(() => loadConfig({ ...required, WEB_ADMIN_USER_IDS })).toThrow("WEB_ADMIN_USER_IDS");
    }
  });
  it("requires complete dedicated OAuth credentials, never deriving a secret from the bot token", () => {
    const oauth = { ...required, WEB_ENABLED: "true", WEB_TELEGRAM_CLIENT_ID: "123456", WEB_TELEGRAM_CLIENT_SECRET: "dedicated-oauth-secret", WEB_PUBLIC_URL: "https://chat.example" };
    for (const field of ["WEB_TELEGRAM_CLIENT_ID", "WEB_TELEGRAM_CLIENT_SECRET", "WEB_PUBLIC_URL"] as const) {
      expect(() => loadConfig({ ...oauth, [field]: "" })).toThrow("Telegram login requires");
    }
    for (const WEB_PUBLIC_URL of ["http://chat.example", "https://user:pass@chat.example", "https://chat.example/subpath", "https://chat.example?query=1", "https://chat.example/#hash"]) {
      expect(() => loadConfig({ ...oauth, WEB_PUBLIC_URL })).toThrow("WEB_PUBLIC_URL");
    }
    expect(loadConfig({ ...oauth, WEB_PUBLIC_URL: "http://localhost:3000" }).WEB_PUBLIC_URL).toBe("http://localhost:3000");
    expect(loadConfig(required)).not.toHaveProperty("BOT_ALLOWED_USER_IDS");
    expect(loadConfig({ ...required, WEB_TRUSTED_PROXY_IPS: "127.0.0.1, ::1" }).WEB_TRUSTED_PROXY_IPS).toEqual(["127.0.0.1", "::1"]);
    for (const WEB_TRUSTED_PROXY_IPS of ["proxy.example", "127.0.0.0/8", "invalid"]) {
      expect(() => loadConfig({ ...required, WEB_TRUSTED_PROXY_IPS })).toThrow("WEB_TRUSTED_PROXY_IPS");
    }
    for (const BOT_ALLOWED_USER_IDS of ["0", "-1", "1.5", "1,", "1,nope", "9007199254740992"]) {
      expect(loadConfig({ ...required, BOT_ALLOWED_USER_IDS })).not.toHaveProperty("BOT_ALLOWED_USER_IDS");
    }
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
    expect(loadConfig({ ...required, PI_REQUEST_TIMEOUT_MS: "60000" }).PI_REQUEST_TIMEOUT_MS).toBe(60_000);
    for (const value of ["0", "-1", "1.5", "Infinity", "invalid"]) {
      expect(() => loadConfig({ ...required, PI_REQUEST_TIMEOUT_MS: value })).toThrow();
    }
  });

  it("keeps a finite recovery grace period for legacy ownerless turns", () => {
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
  it("parses the configured transcription model and timeout", () => {
    expect(loadConfig({ ...required, OPENROUTER_TRANSCRIPTION_MODEL: "vendor/stt", TRANSCRIPTION_TIMEOUT_MS: "60000" }))
      .toMatchObject({ OPENROUTER_TRANSCRIPTION_MODEL: "vendor/stt", TRANSCRIPTION_TIMEOUT_MS: 60_000 });
  });

  it("rejects an empty model and unbounded timeout", () => {
    expect(() => loadConfig({ ...required, OPENROUTER_TRANSCRIPTION_MODEL: " " })).toThrow();
    expect(() => loadConfig({ ...required, TRANSCRIPTION_TIMEOUT_MS: "0" })).toThrow();
  });
});

describe("global OptMem configuration", () => {
  it("parses memory budgets from the environment", () => {
    expect(loadConfig({ ...required, OPTMEM_WAKE_LINES: "128", OPTMEM_ENTRY_CHARS: "120", OPTMEM_PART_CHARS: "12000", OPTMEM_PART_LINES: "100" }))
      .toMatchObject({ OPTMEM_WAKE_LINES: 128, OPTMEM_ENTRY_CHARS: 120, OPTMEM_PART_CHARS: 12000, OPTMEM_PART_LINES: 100 });
  });
  it("rejects invalid budgets and notes above the original byte limit", () => {
    for (const key of ["OPTMEM_WAKE_LINES", "OPTMEM_ENTRY_CHARS", "OPTMEM_PART_CHARS", "OPTMEM_PART_LINES"]) {
      for (const value of ["", "0", "-1", "1.5", "NaN", "9007199254740992"]) {
        expect(() => loadConfig({ ...required, [key]: value })).toThrow(key);
      }
    }
    expect(() => loadConfig({ ...required, OPTMEM_ENTRY_CHARS: "281" })).toThrow("OPTMEM_ENTRY_CHARS");
  });
});
