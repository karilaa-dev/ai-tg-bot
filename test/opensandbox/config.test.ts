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
    })).toThrow("never mounted into a user sandbox");
  });
});
