import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { buildToolRegistry } from "../../src/ai/tools/index.js";
import type { SandboxCommandRequest, SandboxCommandResult, CommandRuntime } from "../../src/sandbox/types.js";

const SANDBOX_USER_ID = 71;

describe("OpenSandbox bash tool contract", () => {
  let db: AppDatabase;
  let repos: Repos;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-opensandbox-bash-"));
    const config = loadTestConfig();
    db = createDatabase(config);
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("maps the stable bash tool contract to a per-thread OpenSandbox command", async () => {
    const runtime = new FakeRuntime();
    const { bash, thread } = await createBash(runtime);
    const result = await bash.execute({
      script: "printf '%s' \"$1\"; cat",
      cwd: "/project",
      stdin: "stdin-value",
      args: ["arg-value"],
      raw_script: true,
    });

    expect(result).toMatchObject({
      stdout: "ok\n",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      cwd: "/project",
      input_files: [],
    });
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({
      command: "bash",
      args: ["-c", "printf '%s' \"$1\"; cat", "bash", "arg-value"],
      stdin: "stdin-value",
      workingDir: `/data/threads/${thread.id}/workspace/project`,
      env: { TZ: "UTC" },
    });
  });

  it("maps a leaked bot host cwd back to the thread workspace", async () => {
    const runtime = new FakeRuntime();
    const { bash, thread } = await createBash(runtime);

    const result = await bash.execute({
      script: "pwd",
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({ exit_code: 0, cwd: "/" });
    expect(runtime.requests[0]?.workingDir).toBe(`/data/threads/${thread.id}/workspace`);
  });

  it("stages only requested scoped attachments and removes copies after execution", async () => {
    const bytes = Buffer.from("attachment bytes");
    const runtime = new FakeRuntime(async (request) => {
      const guestPath = stagedGuestPath(request);
      const relative = path.posix.relative("/data", guestPath);
      const hostPath = path.join(tempDir, "agent", "users", String(SANDBOX_USER_ID), relative);
      await expect(fs.readFile(hostPath)).resolves.toEqual(bytes);
      return successfulCommand("staged\n");
    });
    const { bash, thread, user } = await createBash(runtime);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "input.txt",
      path: null,
      size: bytes.length,
      summary: "input",
      isInline: true,
    });
    const resolveFile = vi.fn(async () => ({
      path: "",
      bytes,
      size: bytes.length,
      mimeType: "text/plain",
      contentSha256: "hash",
      expiresAt: Number.POSITIVE_INFINITY,
      source: { transport: "test", connectionKey: "default", remoteKey: String(file.id), locator: {} },
    }));
    const config = testConfig();
    const tool = buildToolRegistry({ config, db, repos, user, thread, commandRuntime: runtime, resolveFile }).bash;

    const result = await tool.execute({
      script: `wc -c "$CHAT_FILE_${file.id}"`,
      input_file_ids: [file.id],
    });
    expect(result).toMatchObject({
      exit_code: 0,
      input_files: [{ file_id: file.id, name: "input.txt", size: bytes.length }],
    });
    expect(resolveFile).toHaveBeenCalledTimes(1);
    const attachmentRoot = path.join(
      tempDir,
      "agent",
      "users",
      String(SANDBOX_USER_ID),
      "threads",
      String(thread.id),
      "attachments",
    );
    await expect(fs.readdir(attachmentRoot)).resolves.toEqual([]);
  });

  it("preserves the command exit code when attachment cleanup fails", async () => {
    const bytes = Buffer.from("attachment bytes");
    const runtime = new FakeRuntime();
    const config = testConfig();
    const user = await repos.users.ensure({ tgId: SANDBOX_USER_ID, firstName: "OpenSandbox", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "input.txt",
      path: null,
      size: bytes.length,
      summary: "input",
      isInline: true,
    });
    const resolveFile = vi.fn(async () => ({
      path: "",
      bytes,
      size: bytes.length,
      mimeType: "text/plain",
      contentSha256: "hash",
      expiresAt: Number.POSITIVE_INFINITY,
      source: { transport: "test", connectionKey: "default", remoteKey: String(file.id), locator: {} },
    }));
    const logger = {
      level: "debug" as const,
      isLevelEnabled: () => true,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const realRm = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(`${path.sep}attachments${path.sep}`)) {
        throw new Error("cleanup unavailable");
      }
      return realRm(target, options);
    });
    try {
      const bash = buildToolRegistry({
        config,
        db,
        repos,
        user,
        thread,
        commandRuntime: runtime,
        resolveFile,
        logger,
      }).bash;

      const result = await bash.execute({ script: "true", input_file_ids: [file.id] });

      expect(result).toMatchObject({
        exit_code: 0,
        error: expect.stringContaining("attachment cleanup failed: Error: cleanup unavailable"),
      });
      expect(logger.warn).toHaveBeenCalledWith("sandbox attachment cleanup failed", expect.any(Object));
    } finally {
      remove.mockRestore();
    }
  });

  it("rejects attachments from another thread before starting OpenSandbox", async () => {
    const runtime = new FakeRuntime();
    const { bash, user } = await createBash(runtime);
    const other = await repos.threads.create({ userId: user.tg_id, topicId: 2, title: "Other" });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: other.id,
      type: "txt",
      name: "other.txt",
      path: null,
      size: 1,
      summary: "other",
      isInline: true,
    });
    await expect(bash.execute({ script: "true", input_file_ids: [file.id] }))
      .rejects.toThrow("not available in this thread");
    expect(runtime.requests).toHaveLength(0);
  });

  it("returns embedded runtime initialization errors to the model", async () => {
    const runtime = new FakeRuntime(async () => {
      throw new Error("OpenSandbox server is unavailable");
    });
    const config = loadTestConfig({
      AGENT_SHARED_ROOT: path.join(tempDir, "agent"),
      MANAGED_FILE_ROOT: path.join(tempDir, "agent", ".chat-files"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "legacy-bash"),
    });
    const user = await repos.users.ensure({ tgId: 72, firstName: "Runtime", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const bash = buildToolRegistry({ config, db, repos, user, thread, commandRuntime: runtime }).bash;

    const result = await bash.execute({ script: "true" });

    expect(result).toMatchObject({
      exit_code: null,
      error: "Error: OpenSandbox server is unavailable",
    });
  });

  async function createBash(runtime: CommandRuntime) {
    const config = testConfig();
    const user = await repos.users.ensure({ tgId: SANDBOX_USER_ID, firstName: "OpenSandbox", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const bash = buildToolRegistry({ config, db, repos, user, thread, commandRuntime: runtime }).bash;
    return { bash, user, thread };
  }

  function testConfig() {
    return loadTestConfig({
      AGENT_SHARED_ROOT: path.join(tempDir, "agent"),
      MANAGED_FILE_ROOT: path.join(tempDir, "agent", ".chat-files"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "legacy-bash"),
    });
  }
});

class FakeRuntime implements CommandRuntime {
  readonly requests: SandboxCommandRequest[] = [];

  constructor(
    private readonly handler: (request: SandboxCommandRequest) => Promise<SandboxCommandResult> = async () =>
      successfulCommand("ok\n"),
  ) {}

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.requests.push(request);
    return this.handler(request);
  }

  async exportFile(): Promise<void> {
    throw new Error("export not configured");
  }

  async reconcile(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function stagedGuestPath(request: SandboxCommandRequest): string {
  const guestPath = Object.entries(request.env).find(([key]) => key.startsWith("CHAT_FILE_"))?.[1];
  if (!guestPath) throw new Error("expected a staged chat file path");
  return guestPath;
}

function successfulCommand(stdout: string): SandboxCommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
