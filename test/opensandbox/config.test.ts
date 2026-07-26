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
      OPENSANDBOX_EGRESS_DNS_UPSTREAM: " 1.1.1.1, 8.8.8.8:5353 ",
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
      OPENSANDBOX_EGRESS_DNS_UPSTREAM: "1.1.1.1:53,8.8.8.8:5353",
      OPEN_SANDBOX_IDLE_PAUSE_MS: 300_000,
      OPEN_SANDBOX_IDLE_RELEASE_MS: 900_000,
    });
  });

  it("defaults runner names and normalizes optional URLs", () => {
    expect(loadConfig({ ...required, DOCLING_URL: "   " })).toMatchObject({
      OPEN_SANDBOX_USER: "agent",
      OPEN_SANDBOX_GROUP: "agent",
      OPENSANDBOX_EGRESS_DNS_UPSTREAM: "1.1.1.1:53,8.8.8.8:53",
      DOCLING_URL: undefined,
    });
    expect(loadConfig({ ...required, DOCLING_URL: "  https://docling.example.test/api  " }).DOCLING_URL)
      .toBe("https://docling.example.test/api");
    expect(() => loadConfig({ ...required, DOCLING_URL: "not a url" })).toThrow();
  });

  it("rejects private or named DNS upstreams", () => {
    expect(() => loadConfig({
      ...required,
      OPENSANDBOX_EGRESS_DNS_UPSTREAM: "100.100.100.100",
    })).toThrow("globally routable public IP");
    expect(() => loadConfig({
      ...required,
      OPENSANDBOX_EGRESS_DNS_UPSTREAM: "resolver.internal",
    })).toThrow("IPv4 or IPv6 literal");
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
