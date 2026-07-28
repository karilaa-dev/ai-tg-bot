import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const required = {
  BOT_TOKEN: "TEST:TOKEN",
  OPENROUTER_API_KEY: "test-openrouter",
  TAVILY_API_KEY: "test-tavily",
  OPEN_SANDBOX_API_KEY: "test-opensandbox",
};

describe("OpenSandbox configuration", () => {
  it("parses explicit connection, resource, and boolean settings", () => {
    const config = loadConfig({
      ...required,
      OPEN_SANDBOX_DOMAIN: "opensandbox.internal:8080",
      OPEN_SANDBOX_PROTOCOL: "https",
      OPEN_SANDBOX_USE_SERVER_PROXY: "0",
      OPEN_SANDBOX_SHARED_HOST_ROOT: "/srv/ai-tg-bot",
      OPEN_SANDBOX_CPU: "1.5",
      OPEN_SANDBOX_MEMORY: "1Gi",
      OPEN_SANDBOX_USER: "runner",
      OPEN_SANDBOX_GROUP: "runners",
      OPEN_SANDBOX_UID: "2000",
      OPEN_SANDBOX_GID: "2001",
      OPEN_SANDBOX_IDLE_PAUSE_MS: "300000",
      OPEN_SANDBOX_IDLE_RELEASE_MS: "900000",
    });

    expect(config).toMatchObject({
      OPEN_SANDBOX_DOMAIN: "opensandbox.internal:8080",
      OPEN_SANDBOX_PROTOCOL: "https",
      OPEN_SANDBOX_USE_SERVER_PROXY: false,
      OPEN_SANDBOX_SHARED_HOST_ROOT: "/srv/ai-tg-bot",
      OPEN_SANDBOX_CPU: "1.5",
      OPEN_SANDBOX_MEMORY: "1Gi",
      OPEN_SANDBOX_USER: "runner",
      OPEN_SANDBOX_GROUP: "runners",
      OPEN_SANDBOX_UID: 2000,
      OPEN_SANDBOX_GID: 2001,
      OPEN_SANDBOX_IDLE_PAUSE_MS: 300_000,
      OPEN_SANDBOX_IDLE_RELEASE_MS: 900_000,
    });
  });

  it("defaults runner names and normalizes optional URLs", () => {
    expect(loadConfig({ ...required, DOCLING_URL: "   " })).toMatchObject({
      OPEN_SANDBOX_USER: "agent",
      OPEN_SANDBOX_GROUP: "agent",
      DOCLING_URL: undefined,
    });
    expect(loadConfig({ ...required, DOCLING_URL: "  https://docling.example.test/api  " }).DOCLING_URL)
      .toBe("https://docling.example.test/api");
    expect(() => loadConfig({ ...required, DOCLING_URL: "not a url" })).toThrow();
  });

  it("accepts tokenless Browserless WebSocket and REST configurations", () => {
    expect(loadConfig({
      ...required,
      BROWSERLESS_URL: "  ws://browserless:3000/chromium/playwright?blockAds=true  ",
      BROWSERLESS_ALLOWED_ORIGINS: " ws://browserless:3000, https://browserless.example ",
    })).toMatchObject({
      BROWSERLESS_URL: "ws://browserless:3000/chromium/playwright?blockAds=true",
      BROWSERLESS_ALLOWED_ORIGINS: ["ws://browserless:3000", "https://browserless.example"],
      BROWSERLESS_TIMEOUT_MS: 30_000,
    });
    expect(loadConfig({
      ...required,
      BROWSERLESS_URL: "https://browserless.example",
      BROWSERLESS_ALLOWED_ORIGINS: "https://browserless.example",
      BROWSERLESS_TOKEN: " secret ",
      BROWSERLESS_TIMEOUT_MS: "45000",
    })).toMatchObject({
      BROWSERLESS_URL: "https://browserless.example",
      BROWSERLESS_TOKEN: "secret",
      BROWSERLESS_TIMEOUT_MS: 45_000,
    });
  });

  it("rejects unsafe Browserless URLs and tokens without a URL", () => {
    for (const BROWSERLESS_URL of [
      "ftp://browserless.example/chromium/playwright",
      "ws://browserless:3000/chromium",
      "https://browserless.example?blockAds=true",
      "wss://browserless.example/chromium/playwright?token=secret",
      "wss://user:pass@browserless.example/chromium/playwright",
      "wss://browserless.example/chromium/playwright#fragment",
    ]) {
      expect(() => loadConfig({
        ...required,
        BROWSERLESS_URL,
        BROWSERLESS_ALLOWED_ORIGINS: new URL(BROWSERLESS_URL).origin,
      })).toThrow();
    }
    expect(() => loadConfig({
      ...required,
      BROWSERLESS_URL: "not a URL",
      BROWSERLESS_ALLOWED_ORIGINS: "wss://browserless.example",
    })).toThrow("valid URL");
    expect(() => loadConfig({ ...required, BROWSERLESS_TOKEN: "secret" })).toThrow("requires BROWSERLESS_URL");
    expect(() => loadConfig({
      ...required,
      BROWSERLESS_URL: "wss://browserless.example/chromium/playwright",
    })).toThrow("BROWSERLESS_ALLOWED_ORIGINS");
    expect(() => loadConfig({
      ...required,
      BROWSERLESS_URL: "wss://browserless.example/chromium/playwright",
      BROWSERLESS_ALLOWED_ORIGINS: "wss://other.example",
    })).toThrow("must be listed exactly");
    expect(() => loadConfig({
      ...required,
      BROWSERLESS_URL: "wss://browserless.example/chromium/playwright",
      BROWSERLESS_ALLOWED_ORIGINS: "wss://browserless.example/path",
    })).toThrow("only an exact URL origin");
  });

  it("rejects root as the OpenSandbox command identity", () => {
    expect(() => loadConfig({
      ...required,
      OPEN_SANDBOX_UID: "0",
    })).toThrow();
    expect(() => loadConfig({
      ...required,
      OPEN_SANDBOX_GID: "0",
    })).toThrow();
  });

  it("requires an absolute non-root server-visible shared path", () => {
    expect(() => loadConfig({
      ...required,
      OPEN_SANDBOX_SHARED_HOST_ROOT: "relative/shared",
    })).toThrow("absolute host path");

    expect(() => loadConfig({
      ...required,
      OPEN_SANDBOX_SHARED_HOST_ROOT: path.parse(path.resolve("/")).root,
    })).toThrow("filesystem root");
  });

  it("keeps canonical managed files outside mounted user trees", () => {
    expect(() => loadConfig({
      ...required,
      AGENT_SHARED_ROOT: "/srv/shared",
      OPEN_SANDBOX_SHARED_HOST_ROOT: "/srv/shared",
      MANAGED_FILE_ROOT: "/srv/shared/users/42/.chat-files",
    })).toThrow("never mounted into a thread sandbox");
  });

  it("requires idle release to happen after idle pause", () => {
    expect(() => loadConfig({
      ...required,
      OPEN_SANDBOX_IDLE_PAUSE_MS: "300000",
      OPEN_SANDBOX_IDLE_RELEASE_MS: "300000",
    })).toThrow("must be greater than OPEN_SANDBOX_IDLE_PAUSE_MS");
  });
});
