import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import {
  botOutboxRoot,
  botSharedRoot,
  botThreadWorkspace,
  botUserRoot,
  guestCreatedFilePath,
  guestCwd,
  guestThreadWorkspace,
} from "../../src/sandbox/paths.js";

describe("sandbox shared paths", () => {
  const userId = 42;
  const threadId = 7;
  const config = loadTestConfig({ AGENT_SHARED_ROOT: "/data" });

  it("maps user and thread roots across host and guest views", () => {
    expect(botUserRoot(config, userId)).toBe(path.join("/data", "users", "42"));
    expect(botSharedRoot(config, userId)).toBe(path.join("/data", "users", "42", "shared"));
    expect(botThreadWorkspace(config, userId, threadId))
      .toBe(path.join("/data", "users", "42", "threads", "7", "workspace"));
    expect(guestThreadWorkspace(threadId)).toBe("/data/threads/7/workspace");
  });

  it("maps logical cwd into the current thread workspace", () => {
    expect(guestCwd(threadId, "/")).toBe("/data/threads/7/workspace");
    expect(guestCwd(threadId, "/project/src")).toBe("/data/threads/7/workspace/project/src");
    expect(guestCwd(threadId, "/data/shared/reports")).toBe("/data/shared/reports");
    expect(() => guestCwd(threadId, "/data/threads/8/workspace")).toThrow("thread workspace");
  });

  it("maps created files to guest paths and uses a private host outbox", () => {
    expect(guestCreatedFilePath(threadId, "/report.txt")).toBe("/data/threads/7/workspace/report.txt");
    expect(guestCreatedFilePath(threadId, "/data/shared/report.txt")).toBe("/data/shared/report.txt");
    expect(() => guestCreatedFilePath(threadId, "/data/threads/8/workspace/report.txt"))
      .toThrow("this thread workspace");
    expect(botOutboxRoot(config)).toBe(path.join("/data", ".outbox"));
  });
});
