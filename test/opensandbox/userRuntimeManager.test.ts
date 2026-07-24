import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionHandlers, RunCommandOpts, WriteEntry } from "@alibaba-group/opensandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import type {
  OpenSandboxClient,
  OpenSandboxConnection,
  OpenSandboxCreateSpec,
  OpenSandboxInfo,
} from "../../src/opensandbox/client.js";
import {
  METADATA_FINGERPRINT,
  METADATA_USER_ID,
  userSandboxMetadata,
} from "../../src/opensandbox/spec.js";
import {
  quoteShellToken,
  shellJoin,
  UserOpenSandboxRuntimeManager,
} from "../../src/opensandbox/userRuntimeManager.js";
import type { SandboxCommandRequest } from "../../src/sandbox/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("UserOpenSandboxRuntimeManager", () => {
  it("does not initialize an unused client provider", async () => {
    const client = new FakeClient();
    const provider = vi.fn(async () => client);
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), clientProvider: provider });

    await manager.dispose();

    expect(provider).not.toHaveBeenCalled();
    expect(client.closeCalls).toBe(0);
  });

  it("retries initialization after a control-plane failure", async () => {
    const client = new FakeClient();
    const provider = vi.fn()
      .mockRejectedValueOnce(new Error("server unavailable"))
      .mockResolvedValue(client);
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), clientProvider: provider });

    await expect(manager.execute(command(1))).rejects.toThrow("server unavailable");
    await expect(manager.execute(command(1))).resolves.toMatchObject({ stdout: "ok\n", exitCode: 0 });

    expect(provider).toHaveBeenCalledTimes(2);
    await manager.dispose();
  });

  it("adopts a sandbox created by an earlier manager instance", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const metadata = userSandboxMetadata(config, 2);
    client.infos.set("existing", info("existing", "Running", metadata));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await expect(manager.execute(command(2))).resolves.toMatchObject({ stdout: "ok\n", exitCode: 0 });

    expect(client.connectCalls).toEqual(["existing"]);
    expect(client.createCalls).toBe(0);
    await manager.dispose();
  });

  it("adopts the newest duplicate and removes the others", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const metadata = userSandboxMetadata(config, 3);
    client.infos.set("older", info("older", "Running", metadata, new Date("2026-01-01")));
    client.infos.set("newer", info("newer", "Running", metadata, new Date("2026-01-02")));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(3));

    expect(client.connectCalls).toEqual(["newer"]);
    expect(client.killCalls).toEqual(["older"]);
    expect(client.createCalls).toBe(0);
    await manager.dispose();
  });

  it("removes an obsolete provisioning fingerprint before creating a replacement", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    client.infos.set("obsolete", info("obsolete", "Running", {
      ...userSandboxMetadata(config, 4),
      [METADATA_FINGERPRINT]: "obsolete",
    }));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(4));

    expect(client.killCalls).toContain("obsolete");
    expect(client.createCalls).toBe(1);
    expect(client.connections.at(-1)?.id).not.toBe("obsolete");
    await manager.dispose();
  });

  it("removes an obsolete user sandbox discovered after initial reconciliation", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(5));
    client.infos.set("late-obsolete", info("late-obsolete", "Running", {
      ...userSandboxMetadata(config, 5),
      [METADATA_FINGERPRINT]: "obsolete",
    }));

    await manager.execute(command(5));

    expect(client.killCalls).toContain("late-obsolete");
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it("removes managed sandboxes with malformed user metadata", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    client.infos.set("malformed", info("malformed", "Running", {
      ...userSandboxMetadata(config, 5),
      [METADATA_USER_ID]: "not-a-user",
    }));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(5));

    expect(client.killCalls).toContain("malformed");
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it.each(["Terminated", "Deleted"])(
    "does not kill an already removed %s sandbox while creating its replacement",
    async (remoteState) => {
      const config = loadTestConfig();
      const client = new FakeClient();
      client.infos.set("removed", info("removed", remoteState, userSandboxMetadata(config, 7)));
      const manager = new UserOpenSandboxRuntimeManager({ config, client });

      await expect(manager.execute(command(7))).resolves.toMatchObject({ exitCode: 0 });

      expect(client.killCalls).not.toContain("removed");
      expect(client.createCalls).toBe(1);
      expect(client.connections.at(-1)?.id).not.toBe("removed");
      await manager.dispose();
    },
  );

  it("adopts a pending sandbox and waits for it to run", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    client.infos.set("pending", info("pending", "Pending", userSandboxMetadata(config, 8)));
    client.getInfoStateOverrides.set("pending", "Running");
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await expect(manager.execute(command(8))).resolves.toMatchObject({ exitCode: 0 });

    expect(client.connectCalls).toEqual(["pending"]);
    expect(client.killCalls).not.toContain("pending");
    expect(client.createCalls).toBe(0);
    await manager.dispose();
  });

  it("waits for a stopping sandbox without killing it again", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    client.infos.set("stopping", info("stopping", "Stopping", userSandboxMetadata(config, 9)));
    client.getInfoStateOverrides.set("stopping", "Terminated");
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await expect(manager.execute(command(9))).resolves.toMatchObject({ exitCode: 0 });

    expect(client.killCalls).not.toContain("stopping");
    expect(client.createCalls).toBe(1);
    expect(client.connections.at(-1)?.id).not.toBe("stopping");
    await manager.dispose();
  });

  it("refuses to create when the managed-sandbox list is inconclusive", async () => {
    const client = new FakeClient({ listError: new Error("list unavailable") });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(6))).rejects.toThrow("list unavailable");

    expect(client.createCalls).toBe(0);
    expect(client.killCalls).toEqual([]);
    await manager.dispose();
  });

  it("reuses one sandbox per user and serializes that user's commands", async () => {
    const client = new FakeClient({ runDelayMs: 10 });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    const [first, second] = await Promise.all([manager.execute(command(10)), manager.execute(command(10))]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(client.createCalls).toBe(1);
    expect(client.connectCalls).toEqual(["sandbox-1"]);
    expect(client.connections[0]?.maxActive).toBe(1);
    await manager.dispose();
  });

  it("keeps command preparation and cleanup inside the per-user queue", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });
    const gate = deferred<void>();
    const events: string[] = [];

    const first = manager.execute(command(11), {
      async beforeExecute() {
        events.push("first-before");
        await gate.promise;
      },
      async afterExecute() {
        events.push("first-after");
      },
    });
    await vi.waitFor(() => expect(events).toEqual(["first-before"]));

    const second = manager.execute(command(11), {
      async beforeExecute() {
        events.push("second-before");
      },
      async afterExecute() {
        events.push("second-after");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first-before"]);

    gate.resolve(undefined);
    await Promise.all([first, second]);

    expect(events).toEqual(["first-before", "first-after", "second-before", "second-after"]);
    await manager.dispose();
  });

  it("does not initialize OpenSandbox when canceled during command preparation", async () => {
    const client = new FakeClient();
    const provider = vi.fn(async () => client);
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), clientProvider: provider });
    const preparationStarted = deferred<void>();
    const releasePreparation = deferred<void>();
    const cleanup = vi.fn(async () => undefined);
    const controller = new AbortController();

    const result = manager.execute({ ...command(12), signal: controller.signal }, {
      async beforeExecute() {
        preparationStarted.resolve(undefined);
        await releasePreparation.promise;
      },
      afterExecute: cleanup,
    });
    await preparationStarted.promise;

    controller.abort();
    releasePreparation.resolve(undefined);

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(provider).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await manager.dispose();
  });

  it("preserves undefined lifecycle rejection reasons", async () => {
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client: new FakeClient() });

    let received: unknown;
    try {
      await manager.execute(command(12), {
        async beforeExecute() {
          throw undefined;
        },
        async afterExecute() {
          throw undefined;
        },
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(AggregateError);
    expect((received as AggregateError).errors).toEqual([undefined, undefined]);
    await manager.dispose();
  });

  it("allows different users to run concurrently", async () => {
    const client = new FakeClient({ runDelayMs: 20 });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await Promise.all([manager.execute(command(20)), manager.execute(command(21))]);

    expect(client.createCalls).toBe(2);
    expect(client.maxActive).toBeGreaterThan(1);
    await manager.dispose();
  });

  it("pauses on idle and resumes the same sandbox", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensandbox-idle-"));
    const config = loadTestConfig({
      OPEN_SANDBOX_IDLE_PAUSE_MS: 1000,
      AGENT_SHARED_ROOT: root,
      OPEN_SANDBOX_SHARED_HOST_ROOT: root,
      MANAGED_FILE_ROOT: path.join(root, ".chat-files"),
    });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(30));
    const sandboxId = client.connections[0]!.id;
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.pauseCalls).toEqual([sandboxId]);

    const sourcePath = path.join(config.AGENT_SHARED_ROOT, "users", "30", "paused-export.txt");
    const destinationPath = path.join(config.MANAGED_FILE_ROOT, "paused-export.txt");
    await fs.writeFile(sourcePath, "exported");
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await manager.exportFile({
      userId: 30,
      guestPath: "/data/paused-export.txt",
      hostDestination: destinationPath,
      maxBytes: 100,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.pauseCalls).toEqual([sandboxId]);

    await manager.execute(command(30));
    expect(client.resumeCalls).toEqual([sandboxId]);
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it("resumes a sandbox paused outside the manager before reuse", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute(command(31));
    const sandboxId = client.connections[0]!.id;
    client.infos.set(sandboxId, { ...client.infos.get(sandboxId)!, state: "Paused" });

    await manager.execute(command(31));

    expect(client.resumeCalls).toEqual([sandboxId]);
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it("replaces a sandbox deleted outside the manager before reuse", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute(command(32));
    const sandboxId = client.connections[0]!.id;
    client.infos.set(sandboxId, { ...client.infos.get(sandboxId)!, state: "Deleted" });

    await manager.execute(command(32));

    expect(client.createCalls).toBe(2);
    expect(client.connections.at(-1)?.id).not.toBe(sandboxId);
    await manager.dispose();
  });

  it("replaces a sandbox that terminates between listing and inspection", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute(command(33));
    const sandboxId = client.connections[0]!.id;
    client.getInfoStateOverrides.set(sandboxId, "Terminated");

    await manager.execute(command(33));

    expect(client.createCalls).toBe(2);
    expect(client.connections.at(-1)?.id).not.toBe(sandboxId);
    await manager.dispose();
  });

  it("removes a sandbox that fails between listing and inspection", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute(command(34));
    const sandboxId = client.connections[0]!.id;
    client.getInfoStateOverrides.set(sandboxId, "Failed");

    await manager.execute(command(34));

    expect(client.killCalls).toContain(sandboxId);
    expect(client.createCalls).toBe(2);
    expect(client.connections.at(-1)?.id).not.toBe(sandboxId);
    await manager.dispose();
  });

  it("interrupts a timed-out command and keeps the sandbox reusable", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({ waitForInterrupt: true });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });
    const result = manager.execute({ ...command(40), timeoutMs: 1000 });
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toMatchObject({ timedOut: true, exitCode: null });
    expect(client.connections[0]?.interruptCalls).toEqual([client.connections[0]?.lastExecutionId]);
    client.options.waitForInterrupt = false;
    await expect(manager.execute(command(40))).resolves.toMatchObject({ exitCode: 0 });
    await manager.dispose();
  });

  it("interrupts an aborted command and rejects with the abort reason", async () => {
    const client = new FakeClient({ waitForInterrupt: true });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });
    const controller = new AbortController();
    const result = manager.execute({ ...command(41), signal: controller.signal });
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    const connection = client.connections[0]!;
    expect(connection.interruptCalls).toEqual([connection.lastExecutionId]);
    expect(connection.deleteCalls).toHaveLength(1);
    expect(connection.deleteCalls[0]).toHaveLength(3);
    expect(connection.deleteCalls[0]).toContain(connection.writeEntries[0]!.path);
    await manager.dispose();
  });

  it("removes a sandbox after uncertain interruption before the next command", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({
      waitForInterrupt: true,
      interruptError: new Error("interrupt unavailable"),
    });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });
    const first = manager.execute({ ...command(42), timeoutMs: 1000 });
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());
    const quarantinedId = client.connections[0]!.id;

    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toMatchObject({ timedOut: true });

    client.options.waitForInterrupt = false;
    client.options.interruptError = undefined;
    await expect(manager.execute(command(42))).resolves.toMatchObject({ exitCode: 0 });
    expect(client.killCalls).toContain(quarantinedId);
    expect(client.createCalls).toBe(2);
    expect(client.connections.at(-1)?.id).not.toBe(quarantinedId);
    await manager.dispose();
  });

  it("preserves exact stdout and stderr without inventing line endings", async () => {
    const client = new FakeClient({
      stdout: ["compact", "-json"],
      stderr: ["warn", "!"],
    });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(43))).resolves.toMatchObject({
      stdout: "compact-json",
      stderr: "warn!",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(client.connections[0]?.readBytesCalls).toHaveLength(2);
    expect(client.connections[0]?.readBytesCalls.map((call) => call.options)).toEqual([
      { range: "bytes=0-4004" },
      { range: "bytes=0-4004" },
    ]);
    expect(client.connections[0]?.runOptions[1]?.workingDirectory).toBe("/tmp");
    await manager.dispose();
  });

  it("does not confuse a user output byte with the capture sentinel", async () => {
    const client = new FakeClient({ stdout: ["user-output"] });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(43))).resolves.toMatchObject({
      stdout: "user-output",
      stdoutTruncated: false,
    });
    await manager.dispose();
  });

  it("bounds stdout and stderr independently and reports truncation", async () => {
    const client = new FakeClient({
      stdout: ["123", "456"],
      stderr: ["abcde", "f"],
    });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute({ ...command(43), maxOutputChars: 5 })).resolves.toMatchObject({
      stdout: "12345",
      stderr: "abcde",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    await manager.dispose();
  });

  it("uses configured names for stdin ownership and numeric ids for execution", async () => {
    const client = new FakeClient();
    const config = loadTestConfig({
      OPEN_SANDBOX_USER: "runner",
      OPEN_SANDBOX_GROUP: "runners",
      OPEN_SANDBOX_UID: 2200,
      OPEN_SANDBOX_GID: 2201,
    });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute({ ...command(44), stdin: "input data" });

    const connection = client.connections[0]!;
    expect(connection.writeEntries).toHaveLength(1);
    expect(connection.writeEntries[0]).toMatchObject({
      data: "input data",
      mode: 600,
      owner: "runner",
      group: "runners",
    });
    expect(connection.runOptions[0]).toMatchObject({ uid: 2200, gid: 2201 });
    expect(connection.writeEntries[0]!.path).toMatch(/^\/tmp\/ai-tg-bot-stdin-/);
    expect(connection.deleteCalls).toHaveLength(1);
    expect(connection.deleteCalls[0]).toHaveLength(3);
    expect(connection.deleteCalls[0]).toContain(connection.writeEntries[0]!.path);
    await manager.dispose();
  });

  it("pauses rather than kills a healthy sandbox during shutdown", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });
    await manager.execute(command(45));
    const sandboxId = client.connections[0]!.id;

    await manager.dispose();

    expect(client.pauseCalls).toContain(sandboxId);
    expect(client.killCalls).not.toContain(sandboxId);
    expect(client.closeCalls).toBe(1);
  });

  it("exports only regular files beneath the user's shared root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensandbox-export-"));
    const config = loadTestConfig({
      AGENT_SHARED_ROOT: root,
      OPEN_SANDBOX_SHARED_HOST_ROOT: root,
    });
    const source = path.join(root, "users", "50", "threads", "1", "workspace", "result.txt");
    const destination = path.join(root, ".outbox", "result.txt");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, "result");
    const manager = new UserOpenSandboxRuntimeManager({ config, client: new FakeClient() });

    await manager.exportFile({
      userId: 50,
      guestPath: "/data/threads/1/workspace/result.txt",
      hostDestination: destination,
      maxBytes: 1024,
    });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("result");
    await expect(manager.exportFile({
      userId: 50,
      guestPath: "/etc/passwd",
      hostDestination: `${destination}.bad`,
      maxBytes: 1024,
    })).rejects.toThrow("inside /data");
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("quotes every command token for the outer shell", () => {
    expect(quoteShellToken("a'b")).toBe("'a'\"'\"'b'");
    expect(shellJoin(["bash", "-c", "printf '%s' \"$HOME\""])).toBe(
      "'bash' '-c' 'printf '\"'\"'%s'\"'\"' \"$HOME\"'",
    );
  });
});

type FakeOptions = {
  runDelayMs: number;
  waitForInterrupt: boolean;
  listError?: Error;
  interruptError?: Error;
  stdout: string[];
  stderr: string[];
};

class FakeClient implements OpenSandboxClient {
  readonly options: FakeOptions;
  readonly infos = new Map<string, OpenSandboxInfo>();
  readonly getInfoStateOverrides = new Map<string, string>();
  readonly connections: FakeConnection[] = [];
  readonly pauseCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  readonly connectCalls: string[] = [];
  readonly killCalls: string[] = [];
  createCalls = 0;
  closeCalls = 0;
  active = 0;
  maxActive = 0;

  constructor(options: Partial<FakeOptions> = {}) {
    this.options = {
      runDelayMs: 0,
      waitForInterrupt: false,
      stdout: ["ok\n"],
      stderr: [],
      ...options,
    };
  }

  async list(metadata: Record<string, string>): Promise<OpenSandboxInfo[]> {
    if (this.options.listError) throw this.options.listError;
    return [...this.infos.values()].filter((info) => Object.entries(metadata)
      .every(([key, value]) => info.metadata[key] === value));
  }

  async getInfo(id: string): Promise<OpenSandboxInfo> {
    const info = this.infos.get(id);
    if (!info) throw new Error(`missing sandbox ${id}`);
    const state = this.getInfoStateOverrides.get(id);
    return state ? { ...info, state } : info;
  }

  async create(spec: OpenSandboxCreateSpec): Promise<OpenSandboxConnection> {
    this.createCalls += 1;
    const id = `sandbox-${this.createCalls}`;
    this.infos.set(id, info(id, "Running", spec.metadata));
    return this.connection(id);
  }

  async connect(id: string): Promise<OpenSandboxConnection> {
    this.connectCalls.push(id);
    return this.connection(id);
  }

  async resume(id: string): Promise<OpenSandboxConnection> {
    this.resumeCalls.push(id);
    const current = await this.getInfo(id);
    this.infos.set(id, { ...current, state: "Running" });
    return this.connection(id);
  }

  async pause(id: string): Promise<void> {
    this.pauseCalls.push(id);
    const current = await this.getInfo(id);
    this.infos.set(id, { ...current, state: "Paused" });
  }

  async kill(id: string): Promise<void> {
    this.killCalls.push(id);
    this.infos.delete(id);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  started(): void {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  finished(): void {
    this.active -= 1;
  }

  private connection(id: string): FakeConnection {
    const connection = new FakeConnection(id, this);
    this.connections.push(connection);
    return connection;
  }
}

class FakeConnection implements OpenSandboxConnection {
  readonly interruptCalls: string[] = [];
  readonly writeEntries: WriteEntry[] = [];
  readonly deleteCalls: string[][] = [];
  readonly readBytesCalls: Array<{ path: string; options?: { range?: string; offset?: number; limit?: number } }> = [];
  readonly runOptions: RunCommandOpts[] = [];
  lastExecutionId?: string;
  active = 0;
  maxActive = 0;
  private interrupted?: () => void;

  constructor(readonly id: string, private readonly client: FakeClient) {}

  get options(): FakeOptions {
    return this.client.options;
  }

  getInfo(): Promise<OpenSandboxInfo> {
    return this.client.getInfo(this.id);
  }

  async run(command: string, options: RunCommandOpts, handlers: ExecutionHandlers) {
    this.runOptions.push(options);
    if (command.includes("printf '\\036'")) {
      return { id: `seal-${this.id}-${Date.now()}`, exitCode: 0 };
    }
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.client.started();
    const executionId = `execution-${this.id}-${Date.now()}`;
    this.lastExecutionId = executionId;
    await handlers.onInit?.({ id: executionId, timestamp: Date.now() });
    try {
      if (this.options.waitForInterrupt) {
        await new Promise<void>((resolve) => {
          this.interrupted = resolve;
        });
      } else if (this.options.runDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.runDelayMs));
      }
      for (const text of this.options.stdout) {
        await handlers.onStdout?.({ text, timestamp: Date.now() });
      }
      for (const text of this.options.stderr) {
        await handlers.onStderr?.({ text, timestamp: Date.now() });
      }
      return { id: executionId, exitCode: 0 };
    } finally {
      this.active -= 1;
      this.client.finished();
    }
  }

  async interrupt(executionId: string): Promise<void> {
    this.interruptCalls.push(executionId);
    if (this.options.interruptError) throw this.options.interruptError;
    this.interrupted?.();
  }

  async writeFiles(entries: WriteEntry[]): Promise<void> {
    this.writeEntries.push(...entries);
  }

  async readBytes(
    filePath: string,
    options?: { range?: string; offset?: number; limit?: number },
  ): Promise<Uint8Array> {
    this.readBytesCalls.push({ path: filePath, options });
    const text = filePath.includes("-stdout-")
      ? this.options.stdout.join("")
      : this.options.stderr.join("");
    const bytes = new TextEncoder().encode(`${text}`);
    const range = options?.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) return bytes.slice(Number(range[1]), Number(range[2]) + 1);
    const offset = options?.offset ?? 0;
    return bytes.slice(offset, options?.limit === undefined ? undefined : offset + options.limit);
  }

  async deleteFiles(paths: string[]): Promise<void> {
    this.deleteCalls.push(paths);
  }
  pause(): Promise<void> { return this.client.pause(this.id); }
  resume(): Promise<OpenSandboxConnection> { return this.client.resume(this.id); }
  async close(): Promise<void> {}
}

function info(
  id: string,
  state: string,
  metadata: Record<string, string>,
  createdAt = new Date(),
): OpenSandboxInfo {
  return { id, state, metadata, createdAt };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function command(userId: number): SandboxCommandRequest {
  return {
    userId,
    command: "bash",
    args: ["-c", "printf ok"],
    env: { TZ: "UTC" },
    stdin: "",
    workingDir: "/data",
    timeoutMs: 30_000,
    maxOutputChars: 1000,
  };
}
