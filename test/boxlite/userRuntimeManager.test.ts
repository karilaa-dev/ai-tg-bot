import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { boxCreateOptions, boxNameForUser, boxProvisioningFingerprint, UserBoxRuntimeManager } from "../../src/boxlite/userRuntimeManager.js";
import type {
  BoxClient,
  BoxCommandRequest,
  BoxCreateOptions,
  BoxExecution,
  BoxHandle,
  BoxInfo,
  BoxOutputStream,
} from "../../src/boxlite/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("UserBoxRuntimeManager", () => {
  it("builds deterministic per-user names and maximum-security box options", () => {
    const config = loadTestConfig({ AGENT_SHARED_ROOT: "/srv/boxlite" });
    const fingerprint = boxProvisioningFingerprint(config);
    expect(fingerprint).not.toBe(
      boxProvisioningFingerprint(loadTestConfig({ AGENT_SHARED_ROOT: "/other/boxlite" })),
    );
    expect(boxNameForUser(config, 123, fingerprint)).toBe(`ai-tg-bot-u123-${fingerprint}`);
    expect(boxCreateOptions(config, 123)).toMatchObject({
      image: config.BOXLITE_AGENT_IMAGE,
      cpus: 2,
      memoryMib: 512,
      diskSizeGb: 10,
      autoRemove: false,
      detach: true,
      user: "agent",
      ports: [],
      volumes: [{ hostPath: "/srv/boxlite/users/123", guestPath: "/data", readOnly: false }],
      network: { mode: "enabled" },
      security: {
        jailerEnabled: true,
        seccompEnabled: true,
        networkEnabled: true,
        closeFds: true,
      },
    });
  });

  it("does not initialize an unused BoxLite provider during construction or disposal", async () => {
    const client = new FakeClient();
    const provider = vi.fn(async () => client);
    const manager = new UserBoxRuntimeManager({
      config: loadTestConfig(),
      clientProvider: provider,
    });

    expect(provider).not.toHaveBeenCalled();
    await manager.dispose();

    expect(provider).not.toHaveBeenCalled();
    expect(client.listInfoCalls).toBe(0);
    expect(client.shutdownCalls).toBe(0);
  });

  it("retries provider initialization and reconciles only after a successful attempt", async () => {
    const client = new FakeClient();
    const orphan = new FakeBox("ai-tg-bot-u999-orphan");
    client.boxes.set(orphan.name, orphan);
    const provider = vi.fn()
      .mockRejectedValueOnce(new Error("KVM unavailable"))
      .mockResolvedValue(client);
    const manager = new UserBoxRuntimeManager({
      config: loadTestConfig(),
      clientProvider: provider,
    });

    await expect(manager.execute(command(51, "first"))).rejects.toThrow("KVM unavailable");
    expect(client.listInfoCalls).toBe(0);

    await expect(manager.execute(command(51, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    await expect(manager.execute(command(51, "third"))).resolves.toMatchObject({ stdout: "third\n" });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(client.listInfoCalls).toBe(2);
    expect(orphan.stopCalls).toBe(1);
    await manager.dispose();
    expect(client.shutdownCalls).toBe(1);
  });

  it("shuts down a client that finishes initializing during disposal", async () => {
    const client = new FakeClient();
    const initialization = deferred<BoxClient>();
    const provider = vi.fn(() => initialization.promise);
    const manager = new UserBoxRuntimeManager({
      config: loadTestConfig(),
      clientProvider: provider,
    });
    const execution = manager.execute(command(52, "late"));
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    const disposal = manager.dispose();
    expect(manager.dispose()).toBe(disposal);
    initialization.resolve(client);

    await expect(execution).rejects.toThrow("BoxLite runtime is shutting down");
    await expect(disposal).resolves.toBeUndefined();
    expect(client.createCalls).toBe(0);
    expect(client.shutdownCalls).toBe(1);
  });

  it("uses a configured guest user for provisioning, identity, and execution", async () => {
    const defaultConfig = loadTestConfig();
    const config = loadTestConfig({ BOXLITE_GUEST_USER: "root" });
    expect(boxProvisioningFingerprint(defaultConfig)).toBe(boxProvisioningFingerprint(loadTestConfig()));
    expect(boxProvisioningFingerprint(config)).not.toBe(boxProvisioningFingerprint(defaultConfig));
    expect(boxCreateOptions(config, 123).user).toBe("root");

    const client = new FakeClient();
    const manager = new UserBoxRuntimeManager({ config, client });
    await manager.execute(command(123, "root-user"));

    expect(client.lastCreateOptions?.user).toBe("root");
    expect(client.box.execUsers).toEqual(["root"]);
    await manager.dispose();
  });

  it("acquires lazily, reuses one box per user, and serializes executions", async () => {
    const client = new FakeClient();
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    expect(client.createCalls).toBe(0);
    const first = manager.execute(command(55, "first"));
    const second = manager.execute(command(55, "second"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.stdout).toBe("first\n");
    expect(secondResult.stdout).toBe("second\n");
    expect(client.createCalls).toBe(1);
    expect(client.box.maxActive).toBe(1);
    await manager.dispose();
  });

  it("creates separate boxes for different users", async () => {
    const client = new FakeClient();
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    await Promise.all([manager.execute(command(1, "one")), manager.execute(command(2, "two"))]);
    expect(client.names).toHaveLength(2);
    expect(new Set(client.names).size).toBe(2);
    await manager.dispose();
  });

  it("stops an idle box after the configured timeout and restarts it lazily", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const config = loadTestConfig({ BOXLITE_IDLE_STOP_MS: 10_000 });
    const manager = new UserBoxRuntimeManager({ config, client });
    await manager.execute(command(9, "first"));
    const firstHandle = client.box;
    expect(firstHandle.stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(firstHandle.stopCalls).toBe(1);
    expect(firstHandle.terminal).toBe(true);

    await manager.execute(command(9, "second"));

    expect(client.box).not.toBe(firstHandle);
    expect(firstHandle.handleStartCalls).toBe(0);
    expect(firstHandle.handleExecCalls).toBe(1);
    expect(client.box.handleStartCalls).toBe(1);
    expect(client.box.startCalls).toBe(1);
    await manager.dispose();
  });

  it("retries a transient idle-stop failure", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({ stopFailuresRemaining: 1 });
    const manager = new UserBoxRuntimeManager({
      config: loadTestConfig({ BOXLITE_IDLE_STOP_MS: 1_000 }),
      client,
    });
    await manager.execute(command(15, "idle"));
    const firstHandle = client.box;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstHandle.terminal).toBe(true);
    expect(firstHandle.handleStopCalls).toBe(1);
    const retryHandle = client.box;
    expect(retryHandle).not.toBe(firstHandle);
    expect(retryHandle.stopCalls).toBe(1);
    expect(retryHandle.running).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(retryHandle.handleStopCalls).toBe(1);
    expect(retryHandle.stopCalls).toBe(2);
    expect(retryHandle.running).toBe(false);
    await manager.dispose();
  });

  it("kills a command and reports a timeout", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({ waitForKill: true });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    const result = manager.execute({ ...command(3, "blocked"), timeoutMs: 1000 });
    await vi.waitFor(() => expect(client.box.lastExecution).toBeDefined());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ timedOut: true, exitCode: null, error: "timed out after 1000ms" });
    expect(client.box.lastExecution?.killCalls).toBe(1);
    await manager.dispose();
  });

  it("kills an active execution when aborted", async () => {
    const client = new FakeClient({ waitForKill: true });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    const controller = new AbortController();
    const result = manager.execute({ ...command(4, "blocked"), signal: controller.signal });
    await vi.waitFor(() => expect(client.box.lastExecution).toBeDefined());
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(client.box.lastExecution?.killCalls).toBe(1);
    await manager.dispose();
  });

  it("stops the box and kills an execution that resolves after startup is aborted", async () => {
    const gate = deferred<void>();
    const client = new FakeClient({ execGate: gate.promise });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    const controller = new AbortController();
    const result = manager.execute({ ...command(5, "late"), signal: controller.signal });
    await vi.waitFor(() => expect(client.box.lastExecution).toBeDefined());

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(client.box.stopCalls).toBe(1);

    gate.resolve();
    await vi.waitFor(() => expect(client.box.lastExecution?.killCalls).toBe(1));
    await manager.dispose();
  });

  it("reattaches with a fresh handle after execution startup fails", async () => {
    const client = new FakeClient({ execFailuresRemaining: 1 });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(18, "first"))).rejects.toThrow("execution startup failed");
    const stoppedHandle = client.handles[0]!;
    expect(stoppedHandle.terminal).toBe(true);
    expect(stoppedHandle.handleStopCalls).toBe(1);

    await expect(manager.execute(command(18, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    expect(client.removeCalls).toBe(0);
    expect(client.box).not.toBe(stoppedHandle);
    expect(stoppedHandle.handleStartCalls).toBe(0);
    expect(stoppedHandle.handleExecCalls).toBe(1);
    await manager.dispose();
  });

  it("recreates once for the exact stopped-handle invalidation", async () => {
    const client = new FakeClient({
      execFailuresRemaining: 1,
      invalidateIdentityOnStop: true,
    });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(21, "first"))).rejects.toThrow("execution startup failed");
    const stoppedHandle = client.handles[0]!;
    expect(stoppedHandle.handleStopCalls).toBe(1);

    await expect(manager.execute(command(21, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    await expect(manager.execute(command(21, "third"))).resolves.toMatchObject({ stdout: "third\n" });

    expect(client.removeRequests).toEqual([{ idOrName: stoppedHandle.name, force: true }]);
    expect(client.createCalls).toBe(2);
    expect(client.handles[1]?.handleStartCalls).toBe(1);
    expect(client.box.name).toBe(stoppedHandle.name);
    await manager.dispose();
  });

  it("removes the replacement and stops after one invalidation retry", async () => {
    const config = loadTestConfig();
    const userId = 24;
    const name = boxNameForUser(config, userId, boxProvisioningFingerprint(config));
    const options: FakeOptions = {
      initiallyRunning: false,
      startInvalidationsRemaining: 2,
    };
    const client = new FakeClient(options);
    client.boxes.set(name, new FakeBox(name, options));
    const manager = new UserBoxRuntimeManager({ config, client });

    await expect(manager.execute(command(userId, "first"))).rejects.toThrow("Handle invalidated after stop()");
    expect(client.removeRequests).toEqual([
      { idOrName: name, force: true },
      { idOrName: name, force: true },
    ]);
    expect(client.createCalls).toBe(1);

    await expect(manager.execute(command(userId, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    expect(client.createCalls).toBe(2);
    await manager.dispose();
  });

  it("removes without retrying when a stopped box fails to restart for another reason", async () => {
    const config = loadTestConfig();
    const userId = 22;
    const name = boxNameForUser(config, userId, boxProvisioningFingerprint(config));
    const options: FakeOptions = {
      initiallyRunning: false,
      startFailuresRemaining: 1,
    };
    const client = new FakeClient(options);
    client.boxes.set(name, new FakeBox(name, options));
    const manager = new UserBoxRuntimeManager({ config, client });

    await expect(manager.execute(command(userId, "first"))).rejects.toThrow("spawn_failed");
    expect(client.removeRequests).toEqual([{ idOrName: name, force: true }]);
    expect(client.createCalls).toBe(0);

    await expect(manager.execute(command(userId, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it("preserves restart and forced-removal failures together", async () => {
    const config = loadTestConfig();
    const userId = 25;
    const name = boxNameForUser(config, userId, boxProvisioningFingerprint(config));
    const options: FakeOptions = {
      initiallyRunning: false,
      startFailuresRemaining: 1,
      removeFailure: new Error("remove unavailable"),
    };
    const client = new FakeClient(options);
    client.boxes.set(name, new FakeBox(name, options));
    const manager = new UserBoxRuntimeManager({ config, client });

    const execution = manager.execute(command(userId, "first"));
    await expect(execution).rejects.toMatchObject({
      message: "BoxLite restart and forced removal both failed",
      errors: [
        expect.objectContaining({ message: expect.stringContaining("spawn_failed") }),
        expect.objectContaining({ message: expect.stringContaining("remove unavailable") }),
      ],
    });
    await manager.dispose();
  });

  it("removes a cached stopped box when its restart fails", async () => {
    const options: FakeOptions = { startFailuresRemaining: 1 };
    const client = new FakeClient(options);
    const config = loadTestConfig();
    const manager = new UserBoxRuntimeManager({ config, client });

    await manager.execute(command(23, "first"));
    const stoppedBox = client.box;
    stoppedBox.markStopped();

    await expect(manager.execute(command(23, "second"))).rejects.toThrow("spawn_failed");
    expect(client.removeRequests).toEqual([{ idOrName: stoppedBox.name, force: true }]);
    expect(client.createCalls).toBe(1);

    await expect(manager.execute(command(23, "third"))).resolves.toMatchObject({ stdout: "third\n" });
    expect(client.createCalls).toBe(2);
    await manager.dispose();
  });

  it("force-removes by identity when stop rejects after invalidating its handle", async () => {
    const client = new FakeClient({ execFailuresRemaining: 1, stopFailuresRemaining: 1 });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(19, "first"))).rejects.toThrow("execution startup failed");
    const poisonedHandle = client.handles[0]!;
    expect(poisonedHandle.terminal).toBe(true);
    expect(poisonedHandle.handleStopCalls).toBe(1);

    await expect(manager.execute(command(19, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    expect(client.removeRequests).toEqual([{ idOrName: poisonedHandle.name, force: true }]);
    expect(client.createCalls).toBe(2);
    expect(poisonedHandle.handleStopCalls).toBe(1);
    expect(poisonedHandle.handleStartCalls).toBe(0);
    expect(poisonedHandle.handleExecCalls).toBe(1);
    await manager.dispose();
  });

  it("force-removes by identity when stop times out after making its handle terminal", async () => {
    vi.useFakeTimers();
    const stopGate = deferred<void>();
    const client = new FakeClient({ execFailuresRemaining: 1, stopGate: stopGate.promise });
    const manager = new UserBoxRuntimeManager({
      config: loadTestConfig({ BOXLITE_REQUEST_TIMEOUT_MS: 1_000 }),
      client,
    });

    const first = expect(manager.execute(command(20, "first"))).rejects.toThrow("execution startup failed");
    await vi.waitFor(() => expect(client.box.handleStopCalls).toBe(1));
    const terminalHandle = client.handles[0]!;
    expect(terminalHandle.terminal).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    stopGate.resolve();

    await expect(manager.execute(command(20, "second"))).resolves.toMatchObject({ stdout: "second\n" });
    expect(client.removeRequests).toEqual([{ idOrName: terminalHandle.name, force: true }]);
    expect(client.box).not.toBe(terminalHandle);
    expect(terminalHandle.handleStopCalls).toBe(1);
    expect(terminalHandle.handleStartCalls).toBe(0);
    expect(terminalHandle.handleExecCalls).toBe(1);
    await manager.dispose();
  });

  it("terminates an execution when output streams cannot be initialized", async () => {
    const client = new FakeClient({ streamFailure: new Error("stdout failed") });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(6, "broken"))).rejects.toThrow("stdout failed");
    expect(client.box.lastExecution?.killCalls).toBe(1);
    await manager.dispose();
  });

  it("stops the box when timeout cleanup cannot kill a hung execution", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({ hangLifecycle: true, hangKill: true });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    const result = manager.execute({ ...command(7, "hung"), timeoutMs: 1_000 });
    await vi.waitFor(() => expect(client.box.lastExecution).toBeDefined());

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toMatchObject({ timedOut: true, exitCode: null });
    expect(client.box.lastExecution?.killCalls).toBe(1);
    expect(client.box.stopCalls).toBe(1);
    await manager.dispose();
  });

  it("quarantines a user when neither kill, stop, nor force removal can confirm termination", async () => {
    vi.useFakeTimers();
    const options: FakeOptions = {
      hangLifecycle: true,
      hangKill: true,
      stopFailure: new Error("stop unavailable"),
      removeFailure: new Error("remove unavailable"),
    };
    const client = new FakeClient(options);
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    const first = manager.execute({ ...command(16, "hung"), timeoutMs: 1_000 });
    await vi.waitFor(() => expect(client.box.lastExecution).toBeDefined());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(first).resolves.toMatchObject({
      timedOut: true,
      error: expect.stringContaining("termination could not be confirmed"),
    });
    const execCalls = client.box.execCalls;
    await expect(manager.execute(command(16, "blocked"))).rejects.toThrow("recovery failed");
    expect(client.box.execCalls).toBe(execCalls);
    const failedRemovalAttempts = client.removeCalls;
    const quarantinedName = client.box.name;

    options.stopFailure = undefined;
    options.removeFailure = undefined;
    await manager.dispose();
    expect(client.removeCalls).toBe(failedRemovalAttempts + 1);
    expect(client.boxes.has(quarantinedName)).toBe(false);
  });

  it("does not report infrastructure wait failures as process exit codes", async () => {
    const client = new FakeClient({ waitFailure: new Error("daemon wait failed"), exitCode: 0 });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(12, "wait"))).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      error: "Error: daemon wait failed",
    });
    await manager.dispose();
  });

  it("preserves an ordinary nonzero process exit code", async () => {
    const client = new FakeClient({ exitCode: 17 });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(13, "exit"))).resolves.toMatchObject({
      exitCode: 17,
      timedOut: false,
    });
    await manager.dispose();
  });

  it("continues shutdown cleanup and aggregates stop and client-shutdown failures", async () => {
    const client = new FakeClient({
      stopFailure: new Error("stop failed"),
      shutdownFailure: new Error("shutdown failed"),
    });
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    await manager.execute(command(14, "complete"));

    const disposal = manager.dispose();

    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await expect(disposal).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "Error: stop failed" }),
        expect.objectContaining({ message: "Error: shutdown failed" }),
      ],
    });
    expect(client.shutdownCalls).toBe(1);
  });

  it("serializes a new command behind an in-progress idle stop", async () => {
    vi.useFakeTimers();
    const stopGate = deferred<void>();
    const client = new FakeClient({ stopGate: stopGate.promise });
    const manager = new UserBoxRuntimeManager({
      config: loadTestConfig({ BOXLITE_IDLE_STOP_MS: 1_000 }),
      client,
    });
    await manager.execute(command(8, "first"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.box.stopCalls).toBe(1);

    const second = manager.execute(command(8, "second"));
    await Promise.resolve();
    expect(client.box.execCalls).toBe(1);

    stopGate.resolve();
    await expect(second).resolves.toMatchObject({ stdout: "second\n" });
    expect(client.box.startCalls).toBe(1);
    expect(client.box.execCalls).toBe(2);
    await manager.dispose();
  });

  it("replaces a user's box when the immutable image reference changes and reuses it when unchanged", async () => {
    const client = new FakeClient();
    const firstConfig = loadTestConfig({ BOXLITE_AGENT_IMAGE: "ghcr.io/example/agent:sha-old" });
    const firstManager = new UserBoxRuntimeManager({ config: firstConfig, client });
    await firstManager.execute(command(10, "first"));
    await firstManager.dispose();
    const firstName = client.box.name;

    const secondConfig = loadTestConfig({ BOXLITE_AGENT_IMAGE: "ghcr.io/example/agent:sha-new" });
    const secondManager = new UserBoxRuntimeManager({ config: secondConfig, client });
    await secondManager.execute(command(10, "second"));
    const secondName = client.box.name;

    expect(secondName).not.toBe(firstName);
    expect(client.boxes.has(firstName)).toBe(false);
    expect(client.boxes.has(secondName)).toBe(true);
    await secondManager.dispose();

    const createCalls = client.createCalls;
    const thirdManager = new UserBoxRuntimeManager({ config: secondConfig, client });
    await thirdManager.execute(command(10, "third"));
    expect(client.createCalls).toBe(createCalls);
    await thirdManager.dispose();
  });

  it("removes obsolete boxes only for the active user and deployment prefix", async () => {
    const client = new FakeClient();
    const obsoleteName = "ai-tg-bot-u10-obsolete";
    const otherUserName = "ai-tg-bot-u20-obsolete";
    const otherDeploymentName = "other-bot-u10-obsolete";
    client.boxes.set(obsoleteName, new FakeBox(obsoleteName));
    client.boxes.set(otherUserName, new FakeBox(otherUserName));
    client.boxes.set(otherDeploymentName, new FakeBox(otherDeploymentName));

    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });
    await manager.execute(command(10, "cleanup"));

    expect(client.boxes.has(obsoleteName)).toBe(false);
    expect(client.boxes.has(otherUserName)).toBe(true);
    expect(client.boxes.has(otherDeploymentName)).toBe(true);
    await manager.dispose();
  });

  it("force-removes an obsolete box even when its graceful stop fails", async () => {
    const options: FakeOptions = { stopFailure: new Error("stop unavailable") };
    const client = new FakeClient(options);
    const obsoleteName = "ai-tg-bot-u10-obsolete";
    client.boxes.set(obsoleteName, new FakeBox(obsoleteName, options));
    const manager = new UserBoxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute(command(10, "cleanup"));

    expect(client.boxes.has(obsoleteName)).toBe(false);
    expect(client.removeRequests).toContainEqual({ idOrName: obsoleteName, force: true });
    options.stopFailure = undefined;
    await manager.dispose();
  });

  it("uses the configured guest user for every file-export command", async () => {
    const client = new FakeClient();
    const config = loadTestConfig({ BOXLITE_GUEST_USER: "0:0" });
    const manager = new UserBoxRuntimeManager({ config, client });

    await manager.exportFile({
      userId: 11,
      guestPath: "/data/threads/1/workspace/report.txt",
      hostDestination: "/srv/outbox/report.txt",
      maxBytes: 20,
    });

    expect(client.box.execUsers).toEqual(["0:0", "0:0"]);
    expect(client.box.copyOutCalls).toBe(1);
    await manager.dispose();
  });
});

function command(userId: number, marker: string): BoxCommandRequest {
  return {
    userId,
    command: "bash",
    args: ["-c", marker],
    env: { TZ: "UTC" },
    stdin: "",
    workingDir: "/data",
    timeoutMs: 30_000,
    maxOutputChars: 1000,
  };
}

type FakeOptions = {
  waitForKill?: boolean;
  execGate?: Promise<void>;
  execFailuresRemaining?: number;
  initiallyRunning?: boolean;
  invalidateIdentityOnStop?: boolean;
  startFailuresRemaining?: number;
  startInvalidationsRemaining?: number;
  streamFailure?: Error;
  hangLifecycle?: boolean;
  hangKill?: boolean;
  stopGate?: Promise<void>;
  stopFailure?: Error;
  stopFailuresRemaining?: number;
  shutdownFailure?: Error;
  removeFailure?: Error;
  waitFailure?: Error;
  waitErrorMessage?: string;
  exitCode?: number;
};

type FakeBoxState = {
  running: boolean;
  active: number;
  maxActive: number;
  startCalls: number;
  stopCalls: number;
  execCalls: number;
  copyOutCalls: number;
  execUsers: string[];
  lastExecution?: FakeExecution;
  invalidatedAfterStop: boolean;
};

class FakeClient implements BoxClient {
  readonly boxes = new Map<string, FakeBox>();
  readonly names: string[] = [];
  readonly handles: FakeBox[] = [];
  readonly removeRequests: Array<{ idOrName: string; force?: boolean }> = [];
  createCalls = 0;
  listInfoCalls = 0;
  shutdownCalls = 0;
  lastCreateOptions?: BoxCreateOptions;
  box: FakeBox;

  get removeCalls(): number {
    return this.removeRequests.length;
  }

  constructor(private readonly options: FakeOptions = {}) {
    this.box = new FakeBox("unused", options);
  }

  async get(name: string): Promise<BoxHandle | undefined> {
    const stored = this.boxes.get(name);
    if (!stored) return undefined;
    return this.track(stored.reattach());
  }

  async getOrCreate(options: BoxCreateOptions, name: string): Promise<{ box: BoxHandle; created: boolean }> {
    this.lastCreateOptions = options;
    let stored = this.boxes.get(name);
    const created = !stored;
    if (!stored) {
      stored = new FakeBox(name, this.options);
      this.boxes.set(name, stored);
      this.names.push(name);
      this.createCalls += 1;
    }
    return { box: this.track(created ? stored : stored.reattach()), created };
  }

  async listInfo(): Promise<BoxInfo[]> {
    this.listInfoCalls += 1;
    return [...this.boxes.values()].map((box) => box.info());
  }

  async remove(idOrName: string, force?: boolean): Promise<void> {
    this.removeRequests.push({ idOrName, force });
    if (this.options.removeFailure) throw this.options.removeFailure;
    this.boxes.delete(idOrName);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.options.shutdownFailure) throw this.options.shutdownFailure;
  }

  private track(box: FakeBox): FakeBox {
    this.box = box;
    this.handles.push(box);
    return box;
  }
}

class FakeBox implements BoxHandle {
  readonly id: string;
  readonly name: string;
  terminal = false;
  handleStartCalls = 0;
  handleStopCalls = 0;
  handleExecCalls = 0;

  constructor(
    name: string,
    private readonly options: FakeOptions = {},
    private readonly state: FakeBoxState = {
      running: options.initiallyRunning ?? true,
      active: 0,
      maxActive: 0,
      startCalls: 0,
      stopCalls: 0,
      execCalls: 0,
      copyOutCalls: 0,
      execUsers: [],
      invalidatedAfterStop: false,
    },
  ) {
    this.id = name;
    this.name = name;
  }

  get running(): boolean {
    return this.state.running;
  }

  get active(): number {
    return this.state.active;
  }

  get maxActive(): number {
    return this.state.maxActive;
  }

  get startCalls(): number {
    return this.state.startCalls;
  }

  get stopCalls(): number {
    return this.state.stopCalls;
  }

  get execCalls(): number {
    return this.state.execCalls;
  }

  get copyOutCalls(): number {
    return this.state.copyOutCalls;
  }

  get execUsers(): string[] {
    return this.state.execUsers;
  }

  get lastExecution(): FakeExecution | undefined {
    return this.state.lastExecution;
  }

  reattach(): FakeBox {
    return new FakeBox(this.name, this.options, this.state);
  }

  markStopped(): void {
    this.state.running = false;
  }

  info(): BoxInfo {
    return {
      id: this.id,
      name: this.name,
      image: "test",
      cpus: 2,
      memoryMib: 512,
      running: this.running,
      status: this.running ? "running" : "stopped",
    };
  }

  async start(): Promise<void> {
    this.assertUsable();
    this.handleStartCalls += 1;
    this.state.startCalls += 1;
    const invalidationsRemaining = this.options.startInvalidationsRemaining ?? 0;
    if (this.state.invalidatedAfterStop || invalidationsRemaining > 0) {
      if (invalidationsRemaining > 0) {
        this.options.startInvalidationsRemaining = invalidationsRemaining - 1;
      }
      throw new Error("Handle invalidated after stop(). Use runtime.get() to get a new handle.");
    }
    if ((this.options.startFailuresRemaining ?? 0) > 0) {
      this.options.startFailuresRemaining = (this.options.startFailuresRemaining ?? 0) - 1;
      throw new Error("spawn_failed: failed to create container");
    }
    this.state.running = true;
  }

  async stop(): Promise<void> {
    this.assertUsable();
    this.terminal = true;
    this.handleStopCalls += 1;
    this.state.stopCalls += 1;
    await this.options.stopGate;
    if ((this.options.stopFailuresRemaining ?? 0) > 0) {
      this.options.stopFailuresRemaining = (this.options.stopFailuresRemaining ?? 0) - 1;
      throw new Error("transient stop failure");
    }
    if (this.options.stopFailure) throw this.options.stopFailure;
    this.state.running = false;
    if (this.options.invalidateIdentityOnStop) this.state.invalidatedAfterStop = true;
  }

  async copyOut(): Promise<void> {
    this.assertUsable();
    this.state.copyOutCalls += 1;
  }

  async exec(
    _command: string,
    args: string[],
    _env: Array<[string, string]>,
    _tty: boolean,
    user: string,
  ): Promise<BoxExecution> {
    this.assertUsable();
    this.handleExecCalls += 1;
    this.state.execCalls += 1;
    this.state.execUsers.push(user);
    this.state.active += 1;
    this.state.maxActive = Math.max(this.state.maxActive, this.state.active);
    const execution = new FakeExecution(`${args.at(-1)}\n`, this.options, () => {
      this.state.active -= 1;
    });
    this.state.lastExecution = execution;
    await this.options.execGate;
    if ((this.options.execFailuresRemaining ?? 0) > 0) {
      this.options.execFailuresRemaining = (this.options.execFailuresRemaining ?? 0) - 1;
      this.state.active -= 1;
      throw new Error("execution startup failed");
    }
    return execution;
  }

  private assertUsable(): void {
    if (this.terminal) {
      throw new Error("Handle is terminal after stop(). Use BoxClient.get() to get a new handle.");
    }
  }
}

class FakeExecution implements BoxExecution {
  killCalls = 0;
  private killed?: () => void;
  private readonly killedPromise: Promise<void>;

  constructor(
    private readonly output: string,
    private readonly options: FakeOptions,
    private readonly onDone: () => void,
  ) {
    this.killedPromise = new Promise((resolve) => {
      this.killed = resolve;
    });
  }

  async stdin() {
    return { writeString: async () => undefined, close: async () => undefined };
  }

  async stdout(): Promise<BoxOutputStream> {
    if (this.options.streamFailure) throw this.options.streamFailure;
    return this.options.hangLifecycle ? pendingStream() : stream(this.output);
  }

  async stderr(): Promise<BoxOutputStream> {
    return this.options.hangLifecycle ? pendingStream() : stream("");
  }

  async wait() {
    if (this.options.hangLifecycle) return never<{ exitCode: number }>();
    if (this.options.waitForKill) await this.killedPromise;
    if (this.options.waitFailure) throw this.options.waitFailure;
    this.onDone();
    return {
      exitCode: this.options.exitCode ?? 0,
      ...(this.options.waitErrorMessage ? { errorMessage: this.options.waitErrorMessage } : {}),
    };
  }

  async kill(): Promise<void> {
    this.killCalls += 1;
    if (this.options.hangKill) return never<void>();
    this.killed?.();
  }
}

function stream(value: string): BoxOutputStream {
  let consumed = false;
  return {
    async next() {
      if (consumed) return null;
      consumed = true;
      return value || null;
    },
  };
}

function pendingStream(): BoxOutputStream {
  return { next: () => never<string | null>() };
}

function never<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let settle!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  return {
    promise,
    resolve: (value) => settle(value as T | PromiseLike<T>),
  };
}
