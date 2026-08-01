import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import {
  E2B_WEBSITE_IDLE_PAUSE_MS,
  type E2BClient,
  type E2BCommandHandle,
  type E2BSandbox,
} from "../../src/e2b/client.js";
import { E2B_TELEGRAM_FILES, E2B_WORKSPACE } from "../../src/e2b/paths.js";
import { ThreadE2BSandboxRuntimeManager } from "../../src/e2b/threadRuntimeManager.js";
import type { SandboxCommandRequest, SandboxThreadFile } from "../../src/sandbox/types.js";
import { deferred } from "../helpers/async.js";

describe("thread E2B runtime manager", () => {
  let config: AppConfig;
  let db: AppDatabase;
  let repos: Repos;
  let client: FakeClient;
  let runtime: ThreadE2BSandboxRuntimeManager;
  let userId: number;
  let threadId: number;

  beforeEach(async () => {
    config = loadTestConfig();
    db = createDatabase(config);
    await db.initialize();
    repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 7001, firstName: "E2B", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Sandbox" });
    userId = user.tg_id;
    threadId = thread.id;
    client = new FakeClient();
    runtime = createRuntime();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await runtime.dispose();
    await db.destroy();
  });

  it("creates one sandbox per thread and synchronizes Telegram files once as read-only", async () => {
    client.telegramFiles.set("tg-hello", Buffer.from("hello"));
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      contentSha256: createHash("sha256").update("hello").digest("hex"),
      mimeType: "text/plain",
      name: "../draft?.txt",
      size: 5,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      telegramMessageId: 44,
      refs: [{
        fileId: "tg-hello",
        fileUniqueId: "unique-hello",
        size: 5,
        primary: true,
      }],
    });
    const file: SandboxThreadFile = {
      fileId: stored.id,
      messageId: 44,
      name: "../draft?.txt",
      mimeType: "text/plain",
      expectedSize: 5,
      expectedSha256: createHash("sha256").update("hello").digest("hex"),
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: "tg-hello",
        telegramSize: 5,
        isPrimary: true,
        lastSeenAt: Date.now(),
      }],
    };

    const first = await runtime.execute(commandRequest(userId, threadId, [file]));
    const second = await runtime.execute(commandRequest(userId, threadId, [file]));
    const sandbox = client.onlySandbox();
    const restoredPath = `${E2B_TELEGRAM_FILES}/${stored.id}--.._draft?.txt`;
    sandbox.files.set(restoredPath, Buffer.from("x"));
    const repaired = await runtime.execute(commandRequest(userId, threadId, [file]));

    expect(first.threadFiles).toMatchObject({ directory: E2B_TELEGRAM_FILES, available: 1 });
    expect(second.threadFiles.available).toBe(1);
    expect(repaired.threadFiles.available).toBe(1);
    expect(client.createCalls).toBe(1);
    expect(sandbox.metadata.template_ref).toBe(config.E2B_TEMPLATE);
    expect(client.telegramDownloadCalls).toBe(2);
    expect(sandbox.files.get(restoredPath)?.toString()).toBe("hello");
    expect(sandbox.controlCommands.some((command) =>
      command.includes("find '/home/user/telegram-files' -type f -exec chmod 444")))
      .toBe(true);
    expect(sandbox.controlCommands.some((command) =>
      command.includes("chmod 555 '/home/user/telegram-files'")))
      .toBe(true);
    expect(await repos.threadSandboxes.get(config.E2B_DEPLOYMENT_ID, threadId))
      .toMatchObject({ sandbox_id: sandbox.id, thread_id: threadId, user_id: userId });
    expect(await repos.sandboxFileRestores.listForSandbox(config.E2B_DEPLOYMENT_ID, sandbox.id))
      .toMatchObject([{
        file_id: stored.id,
        telegram_file_ref_id: telegramRef!.id,
        status: "available",
        restored_size: 5,
      }]);
  });

  it("records a partial restore failure without surfacing failure details in the command result", async () => {
    const stored = await repos.files.insertFile({
      userId,
      threadId,
      type: "txt",
      mimeType: "text/plain",
      name: "missing.txt",
      size: 7,
      isInline: true,
    });
    const [telegramRef] = await repos.files.rememberTelegramFileRefs(stored.id, {
      direction: "inbound",
      mediaKind: "document",
      refs: [{ fileId: "tg-missing", size: 7, primary: true }],
    });
    const result = await runtime.execute(commandRequest(userId, threadId, [{
      fileId: stored.id,
      messageId: null,
      name: stored.name,
      mimeType: stored.mime_type,
      expectedSize: stored.size,
      expectedSha256: stored.content_sha256,
      telegramRefs: [{
        id: telegramRef!.id,
        telegramFileId: telegramRef!.telegram_file_id,
        telegramSize: telegramRef!.telegram_size,
        isPrimary: true,
        lastSeenAt: telegramRef!.last_seen_at,
      }],
    }]));

    expect(result.exitCode).toBe(0);
    expect(result.threadFiles).toEqual({ directory: E2B_TELEGRAM_FILES, available: 0 });
    expect(result.threadFiles).not.toHaveProperty("failed");
    const index = JSON.parse(await client.onlySandbox().readText(`${E2B_TELEGRAM_FILES}/INDEX.json`));
    expect(index).toMatchObject({
      version: 2,
      files: [{
        file_id: stored.id,
        status: "error",
        error_code: "file_unavailable",
      }],
    });
    expect(await repos.sandboxFileRestores.listForSandbox(
      config.E2B_DEPLOYMENT_ID,
      client.onlySandbox().id,
    )).toMatchObject([{
      file_id: stored.id,
      status: "error",
      error_code: "file_unavailable",
    }]);
  });

  it("uses the website pause delay only after a verified explicit publication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const lease = runtime.acquireActivityLease(userId, threadId);
    await runtime.execute(commandRequest(userId, threadId));
    const published = await runtime.publishWebsite({ userId, threadId, port: 3000, path: "/demo" });
    lease.release();

    await vi.waitFor(() => {
      expect(client.onlySandbox().timeoutCalls.at(-1)).toBe(E2B_WEBSITE_IDLE_PAUSE_MS);
    });
    expect(published).toMatchObject({
      url: "https://3000-sandbox-1.e2b.test/demo",
      pausesAfterMinutes: 15,
    });
  });

  it("rejects an E2B file source from another sandbox or outside the workspace", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    await expect(runtime.readSourceFile({
      sandboxId: "somebody-else",
      userId,
      threadId,
      canonicalPath: `${E2B_WORKSPACE}/secret.txt`,
      maxBytes: 100,
    })).rejects.toThrow("does not belong");
    await expect(runtime.readSourceFile({
      sandboxId: client.onlySandbox().id,
      userId,
      threadId,
      canonicalPath: "/etc/passwd",
      maxBytes: 100,
    })).rejects.toThrow("outside this thread's workspace");
  });

  it("pauses and reconnects before the one-hour continuous runtime limit", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    sandbox.startedAt = new Date(Date.now() - 56 * 60_000);
    await runtime.dispose();
    runtime = createRuntime();

    await runtime.execute(commandRequest(userId, threadId));

    expect(sandbox.pauseCalls).toBe(1);
    expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  });

  it("rejects an aborted command immediately while it is waiting for the thread queue", async () => {
    await runtime.execute(commandRequest(userId, threadId));
    const sandbox = client.onlySandbox();
    const started = deferred<void>();
    const release = deferred<void>();
    sandbox.nextCommandGate = { started, release };
    const active = runtime.execute(commandRequest(userId, threadId));
    await started.promise;

    const controller = new AbortController();
    const queued = runtime.execute({
      ...commandRequest(userId, threadId),
      signal: controller.signal,
    });
    controller.abort(new Error("stopped"));

    await expect(queued).rejects.toThrow("stopped");
    release.resolve();
    await active;
  });

  function createRuntime(): ThreadE2BSandboxRuntimeManager {
    return new ThreadE2BSandboxRuntimeManager({
      config,
      repos,
      client,
      downloadTelegramBytes: async (fileId) => {
        client.telegramDownloadCalls += 1;
        const bytes = client.telegramFiles.get(fileId);
        if (!bytes) throw new Error("Telegram file unavailable");
        return bytes;
      },
    });
  }
});

function commandRequest(
  userId: number,
  threadId: number,
  threadFiles: SandboxThreadFile[] = [],
): SandboxCommandRequest {
  return {
    userId,
    threadId,
    command: "bash",
    args: ["-c", "printf ok"],
    env: {},
    stdin: "",
    workingDir: E2B_WORKSPACE,
    timeoutMs: 30_000,
    maxOutputChars: 1000,
    threadFiles,
  };
}

class FakeClient implements E2BClient {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly telegramFiles = new Map<string, Buffer>();
  telegramDownloadCalls = 0;
  createCalls = 0;
  connectCalls = 0;

  async list(metadata: Record<string, string>) {
    return [...this.sandboxes.values()]
      .filter((sandbox) => Object.entries(metadata).every(([key, value]) => sandbox.metadata[key] === value))
      .map((sandbox) => sandbox.info());
  }

  async getInfo(sandboxId: string) {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error("404 not found");
    return sandbox.info();
  }

  async create(metadata: Record<string, string>): Promise<E2BSandbox> {
    this.createCalls += 1;
    const sandbox = new FakeSandbox(`sandbox-${this.createCalls}`, metadata, this.telegramFiles);
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async connect(sandboxId: string): Promise<E2BSandbox> {
    this.connectCalls += 1;
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error("404 not found");
    sandbox.running = true;
    return sandbox;
  }

  onlySandbox(): FakeSandbox {
    expect(this.sandboxes.size).toBe(1);
    return [...this.sandboxes.values()][0]!;
  }
}

class FakeSandbox implements E2BSandbox {
  readonly files = new Map<string, Buffer>();
  readonly controlCommands: string[] = [];
  readonly timeoutCalls: number[] = [];
  startedAt = new Date();
  running = true;
  pauseCalls = 0;
  readonly readFilePaths: string[] = [];
  nextCommandGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };

  constructor(
    readonly id: string,
    readonly metadata: Record<string, string>,
    readonly telegramFiles: Map<string, Buffer>,
  ) {}

  info() {
    return {
      sandboxId: this.id,
      state: this.running ? "running" : "paused",
      startedAt: this.startedAt,
      metadata: this.metadata,
      name: "desktop",
      templateId: "desktop",
    } as never;
  }

  async run(command: string) {
    this.controlCommands.push(command);
    const realpath = command.match(/^'realpath' '--' '([^']+)'$/)?.[1];
    if (realpath) {
      const candidate = realpath;
      return { stdout: `${candidate}\n`, stderr: "", exitCode: 0 };
    }
    if (command.startsWith("'python3' '-c' ")) {
      const candidate = command.match(/ '([^']+)'$/)?.[1];
      const bytes = candidate ? this.files.get(candidate) : undefined;
      if (!bytes) throw new Error("not found");
      return {
        stdout: JSON.stringify({
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          head_hex: bytes.subarray(0, 4).toString("hex"),
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    for (const match of command.matchAll(/mv -f ('[^']*'|\S+) ('[^']*'|\S+)/g)) {
      const source = unquote(match[1]!);
      const destination = unquote(match[2]!);
      const bytes = this.files.get(source);
      if (bytes) {
        this.files.set(destination, bytes);
        this.files.delete(source);
      }
    }
    for (const match of command.matchAll(/rm -f ('[^']*'|\S+)/g)) {
      this.files.delete(unquote(match[1]!));
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async runBackground(command: string): Promise<E2BCommandHandle> {
    const gate = this.nextCommandGate;
    this.nextCommandGate = undefined;
    gate?.started.resolve();
    const stdoutPath = command.match(/\/tmp\/ai-tg-bot\/[a-f0-9-]+\/stdout/)?.[0];
    const stderrPath = command.match(/\/tmp\/ai-tg-bot\/[a-f0-9-]+\/stderr/)?.[0];
    if (stdoutPath) this.files.set(stdoutPath, Buffer.from("ok"));
    if (stderrPath) this.files.set(stderrPath, Buffer.alloc(0));
    return {
      pid: 123,
      wait: async () => {
        await gate?.release.promise;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      kill: async () => true,
    };
  }

  async writeFile(filePath: string, data: string | Buffer | Uint8Array): Promise<void> {
    this.files.set(filePath, Buffer.from(data));
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    this.readFilePaths.push(filePath);
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error("not found");
    return bytes;
  }

  async readText(filePath: string): Promise<string> {
    return Buffer.from(await this.readFile(filePath)).toString("utf8");
  }

  async fileInfo(filePath: string) {
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error("not found");
    return { type: "file", size: bytes.length } as never;
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }

  async removeFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  getHost(port: number): string {
    return `${port}-${this.id}.e2b.test`;
  }

  async getInfo() {
    return this.info();
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    this.timeoutCalls.push(timeoutMs);
  }

  async pause(): Promise<boolean> {
    this.pauseCalls += 1;
    this.running = false;
    return true;
  }
}

function unquote(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1) : value;
}
