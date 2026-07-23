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
    expect(client.connections[0]?.maxActive).toBe(1);
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
    const manager = new UserOpenSandboxRuntimeManager({
      config: loadTestConfig({ OPEN_SANDBOX_IDLE_PAUSE_MS: 1000 }),
      client,
    });

    await manager.execute(command(30));
    const sandboxId = client.connections[0]!.id;
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.pauseCalls).toEqual([sandboxId]);
    await manager.execute(command(30));
    expect(client.resumeCalls).toEqual([sandboxId]);
    expect(client.createCalls).toBe(1);
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
    expect(connection.deleteCalls).toEqual([[connection.writeEntries[0]!.path]]);
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

  it("removes the per-command stdin file after execution", async () => {
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute({ ...command(44), stdin: "input data" });

    const connection = client.connections[0]!;
    expect(connection.writeEntries).toHaveLength(1);
    expect(connection.writeEntries[0]).toMatchObject({ data: "input data", mode: 0o600 });
    expect(connection.writeEntries[0]!.path).toMatch(/^\/tmp\/ai-tg-bot-stdin-/);
    expect(connection.deleteCalls).toEqual([[connection.writeEntries[0]!.path]]);
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
    return info;
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

  async run(_command: string, _options: RunCommandOpts, handlers: ExecutionHandlers) {
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
