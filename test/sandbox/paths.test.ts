import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import {
  botOutboxRoot,
  botSharedRoot,
  botThreadRoot,
  botThreadWorkspace,
  botUserRoot,
  guestCreatedFilePath,
  guestCwd,
  guestSharedRoot,
  guestThreadRoot,
  guestThreadWorkspace,
  scopedGuestPathToHostPath,
} from "../../src/sandbox/paths.js";

describe("sandbox shared paths", () => {
  const userId = 42;
  const threadId = 7;
  const config = loadTestConfig({ AGENT_SHARED_ROOT: "/data" });

  it("maps user and thread roots across host and guest views", () => {
    expect(botUserRoot(config, userId)).toBe(path.join("/data", "users", "42"));
    expect(botSharedRoot(config, userId)).toBe(path.join("/data", "users", "42", "shared"));
    expect(botThreadRoot(config, userId, threadId))
      .toBe(path.join("/data", "users", "42", "threads", "7"));
    expect(botThreadWorkspace(config, userId, threadId))
      .toBe(path.join("/data", "users", "42", "threads", "7", "workspace"));
    expect(guestSharedRoot()).toBe("/data/shared");
    expect(guestThreadRoot(threadId)).toBe("/data/threads/7");
    expect(guestThreadWorkspace(threadId)).toBe("/data/threads/7/workspace");
  });

  it("maps exports only from the current thread or the user's shared mount", () => {
    expect(scopedGuestPathToHostPath(config, userId, threadId, "/data/threads/7/workspace/report.txt"))
      .toEqual({
        scopeRoot: path.join("/data", "users", "42", "threads", "7", "workspace"),
        sourcePath: path.join("/data", "users", "42", "threads", "7", "workspace", "report.txt"),
      });
    expect(scopedGuestPathToHostPath(config, userId, threadId, "/data/shared/report.txt"))
      .toEqual({
        scopeRoot: path.join("/data", "users", "42", "shared"),
        sourcePath: path.join("/data", "users", "42", "shared", "report.txt"),
      });
    expect(() => scopedGuestPathToHostPath(config, userId, threadId, "/data/threads/8/workspace/secret.txt"))
      .toThrow("current thread");
    expect(() => scopedGuestPathToHostPath(config, userId, threadId, "/data/threads/7/attachments/1"))
      .toThrow("current thread");
    expect(() => scopedGuestPathToHostPath(config, userId, threadId, "/etc/passwd"))
      .toThrow("current thread");
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
