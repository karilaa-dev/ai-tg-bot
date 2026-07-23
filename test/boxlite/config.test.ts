import { describe, expect, it } from "vitest";
import { loadConfig, loadTestConfig } from "../../src/config.js";

describe("BoxLite configuration", () => {
  it("uses local embedded-runtime defaults", () => {
    const config = loadTestConfig();
    expect(config.BOXLITE_HOME).toBe("./data/boxlite");
    expect(config.BOXLITE_MEMORY_MIB).toBe(512);
    expect(config.BOXLITE_CPUS).toBe(2);
    expect(config.BOXLITE_DISK_SIZE_GB).toBe(10);
    expect(config.BOXLITE_IDLE_STOP_MS).toBe(600_000);
    expect(config.BOXLITE_PROVISION_TIMEOUT_MS).toBe(300_000);
    expect(config.BOXLITE_GUEST_USER).toBe("agent");
    expect(config.DOCLING_URL).toBeUndefined();
  });

  it("treats an empty Docling URL as disabled", () => {
    expect(loadConfig(baseEnv({ DOCLING_URL: "" })).DOCLING_URL).toBeUndefined();
  });

  it("accepts an external Docling URL", () => {
    expect(loadConfig(baseEnv({ DOCLING_URL: "https://docling.example" })).DOCLING_URL)
      .toBe("https://docling.example");
  });

  it("accepts an explicit local runtime home", () => {
    expect(loadConfig(baseEnv({ BOXLITE_HOME: "/var/lib/boxlite" })).BOXLITE_HOME)
      .toBe("/var/lib/boxlite");
  });

  it("rejects canonical managed files inside a user-mounted subtree", () => {
    expect(() => loadConfig(baseEnv({
      AGENT_SHARED_ROOT: "/srv/agent",
      MANAGED_FILE_ROOT: "/srv/agent/users/42/chat-files",
      BOXLITE_HOME: "/srv/boxlite",
    }))).toThrow("MANAGED_FILE_ROOT");
  });

  it.each([
    { AGENT_SHARED_ROOT: "/srv/agent", BOXLITE_HOME: "/srv/agent/boxlite" },
    { AGENT_SHARED_ROOT: "/srv/agent/users", BOXLITE_HOME: "/srv/agent" },
  ])("rejects overlapping BoxLite runtime and shared roots", (paths) => {
    expect(() => loadConfig(baseEnv({
      ...paths,
      MANAGED_FILE_ROOT: "/srv/chat-files",
    }))).toThrow("BOXLITE_HOME");
  });

  it.each(["root", "sandbox", "0", "0:0", "1001", "1001:1002", "4294967294"])(
    "accepts BoxLite guest user %s",
    (guestUser) => {
      expect(loadConfig(baseEnv({ BOXLITE_GUEST_USER: guestUser })).BOXLITE_GUEST_USER).toBe(guestUser);
    },
  );

  it.each([
    "",
    "two words",
    "agent:wheel",
    "1001:group",
    "1:2:3",
    "../root",
    "a".repeat(33),
    "4294967295",
    "1000:4294967295",
  ])("rejects invalid BoxLite guest user %j", (guestUser) => {
    expect(() => loadConfig(baseEnv({ BOXLITE_GUEST_USER: guestUser }))).toThrow("BOXLITE_GUEST_USER");
  });
});

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BOT_TOKEN: "TEST:TOKEN",
    OPENROUTER_API_KEY: "test-openrouter",
    TAVILY_API_KEY: "test-tavily",
    ...overrides,
  };
}
