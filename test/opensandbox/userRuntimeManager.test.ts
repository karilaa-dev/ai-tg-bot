import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionHandlers, RunCommandOpts, WriteEntry } from "@alibaba-group/opensandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../helpers/async.js";
import { loadTestConfig } from "../../src/config.js";
import type {
  OpenSandboxClient,
  OpenSandboxConnection,
  OpenSandboxCreateSpec,
  OpenSandboxInfo,
} from "../../src/opensandbox/client.js";
import { createRetryableOpenSandboxClientProvider } from "../../src/opensandbox/client.js";
import {
  METADATA_FINGERPRINT,
  METADATA_THREAD_ID,
  METADATA_USER_ID,
  threadSandboxMetadata,
} from "../../src/opensandbox/spec.js";
import {
  ThreadOpenSandboxRuntimeManager as UserOpenSandboxRuntimeManager,
} from "../../src/opensandbox/threadRuntimeManager.js";
import { quoteShellToken, shellJoin } from "../../src/util/shell.js";
import type { SandboxCommandRequest } from "../../src/sandbox/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ThreadOpenSandboxRuntimeManager", () => {
  it("does not initialize an unused client provider", async () => {
    const client = new FakeClient();
    const provider = vi.fn(async () => client);
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), clientProvider: provider });

    await manager.dispose();

    expect(provider).not.toHaveBeenCalled();
    expect(client.closeCalls).toBe(0);
  });

  it("keeps an unused activity lease lazy", async () => {
    const client = new FakeClient();
    const provider = vi.fn(async () => client);
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), clientProvider: provider });

    const lease = manager.acquireActivityLease(100, 1);
    lease.release();
    lease.release();

    expect(provider).not.toHaveBeenCalled();
    expect(client.createCalls).toBe(0);
    await manager.dispose();
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

  it("closes a provider-created client when reconciliation fails before retrying", async () => {
    const failed = new FakeClient({ listError: new Error("list unavailable") });
    const healthy = new FakeClient();
    const factory = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(healthy);
    const provider = createRetryableOpenSandboxClientProvider(factory);
    const manager = new UserOpenSandboxRuntimeManager({
      config: loadTestConfig(),
      clientProvider: provider,
    });

    await expect(manager.execute(command(101))).rejects.toThrow("list unavailable");
    expect(failed.closeCalls).toBe(1);

    await expect(manager.execute(command(101))).resolves.toMatchObject({ exitCode: 0 });
    await manager.dispose();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(failed.closeCalls).toBe(1);
    expect(healthy.closeCalls).toBe(1);
  });

  it("preserves initialization and client-close failures together", async () => {
    const listError = new Error("list unavailable");
    const closeError = new Error("close unavailable");
    const client = new FakeClient({ listError, closeError });
    const manager = new UserOpenSandboxRuntimeManager({
      config: loadTestConfig(),
      clientProvider: async () => client,
    });

    let received: unknown;
    try {
      await manager.execute(command(102));
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(AggregateError);
    expect((received as AggregateError).errors).toEqual([listError, closeError]);
    expect(client.closeCalls).toBe(1);
    client.options.closeError = undefined;
    await manager.dispose();
    expect(client.closeCalls).toBe(1);
  });

  it("adopts a sandbox created by an earlier manager instance", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const metadata = threadSandboxMetadata(config, 2, 1);
    client.infos.set("existing", info("existing", "Running", metadata));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await expect(manager.execute(command(2))).resolves.toMatchObject({ stdout: "ok\n", exitCode: 0 });

    expect(client.connectCalls).toEqual(["existing"]);
    expect(client.renewCalls).toContainEqual(["existing", config.OPEN_SANDBOX_IDLE_RELEASE_MS]);
    expect(client.createCalls).toBe(0);
    await manager.dispose();
  });

  it("creates sandboxes with a release TTL and renews it after activity", async () => {
    const config = loadTestConfig({
      OPEN_SANDBOX_IDLE_PAUSE_MS: 300_000,
      OPEN_SANDBOX_IDLE_RELEASE_MS: 900_000,
    });
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(200));
    await vi.waitFor(() => expect(client.renewCalls).toContainEqual(["sandbox-1", 900_000]));

    expect(client.createSpecs[0]?.idleReleaseMs).toBe(900_000);
    await manager.dispose();
  });

  it("renews idle release after each activity even when the clock has not advanced", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await manager.execute(command(202));
    const renewalsAfterFirstCommand = client.renewCalls.length;
    await manager.execute(command(202));

    expect(client.renewCalls.length).toBeGreaterThan(renewalsAfterFirstCommand);
    await manager.dispose();
  });

  it("rejects symlinked mount directories before creating a sandbox", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensandbox-mount-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "opensandbox-mount-outside-"));
    const config = loadTestConfig({
      AGENT_SHARED_ROOT: root,
      OPEN_SANDBOX_SHARED_HOST_ROOT: root,
      MANAGED_FILE_ROOT: path.join(root, ".chat-files"),
    });
    const workspace = path.join(root, "users", "201", "threads", "1", "workspace");
    await fs.mkdir(path.dirname(workspace), { recursive: true });
    await fs.symlink(outside, workspace);
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await expect(manager.execute(command(201))).rejects.toThrow("not a plain directory");

    expect(client.createCalls).toBe(0);
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("adopts the newest duplicate and removes the others", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const metadata = threadSandboxMetadata(config, 3, 1);
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
      ...threadSandboxMetadata(config, 4, 1),
      [METADATA_FINGERPRINT]: "obsolete",
    }));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(4));

    expect(client.killCalls).toContain("obsolete");
    expect(client.createCalls).toBe(1);
    expect(client.connections.at(-1)?.id).not.toBe("obsolete");
    await manager.dispose();
  });

  it("removes an obsolete thread sandbox discovered after initial reconciliation", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(5));
    client.infos.set("late-obsolete", info("late-obsolete", "Running", {
      ...threadSandboxMetadata(config, 5, 1),
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
      ...threadSandboxMetadata(config, 5, 1),
      [METADATA_USER_ID]: "not-a-user",
    }));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(5));

    expect(client.killCalls).toContain("malformed");
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it("removes managed sandboxes without a valid thread identity", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    const metadata = threadSandboxMetadata(config, 6, 1);
    delete metadata[METADATA_THREAD_ID];
    client.infos.set("missing-thread", info("missing-thread", "Running", metadata));
    client.infos.set("malformed-thread", info("malformed-thread", "Running", {
      ...threadSandboxMetadata(config, 6, 1),
      [METADATA_THREAD_ID]: "not-a-thread",
    }));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(6));

    expect(client.killCalls).toEqual(expect.arrayContaining(["missing-thread", "malformed-thread"]));
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it.each(["Terminated", "Deleted"])(
    "does not kill an already removed %s sandbox while creating its replacement",
    async (remoteState) => {
      const config = loadTestConfig();
      const client = new FakeClient();
      client.infos.set("removed", info("removed", remoteState, threadSandboxMetadata(config, 7, 1)));
      const manager = new UserOpenSandboxRuntimeManager({ config, client });

      await expect(manager.execute(command(7))).resolves.toMatchObject({ exitCode: 0 });

      expect(client.killCalls).not.toContain("removed");
      expect(client.createCalls).toBe(1);
      expect(client.connections.at(-1)?.id).not.toBe("removed");
      await manager.dispose();
    },
  );

  it("does not kill a sandbox in an unrecognized state", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    client.infos.set("future-state", info(
      "future-state",
      "FutureTransition",
      threadSandboxMetadata(config, 8, 1),
    ));
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await expect(manager.execute(command(8))).resolves.toMatchObject({ exitCode: 0 });

    expect(client.killCalls).not.toContain("future-state");
    expect(client.createCalls).toBe(1);
    await manager.dispose();
  });

  it("adopts a pending sandbox and waits for it to run", async () => {
    const config = loadTestConfig();
    const client = new FakeClient();
    client.infos.set("pending", info("pending", "Pending", threadSandboxMetadata(config, 8, 1)));
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
    client.infos.set("stopping", info("stopping", "Stopping", threadSandboxMetadata(config, 9, 1)));
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
    expect(client.closeCalls).toBe(0);
    await manager.dispose();
    expect(client.closeCalls).toBe(1);
  });

  it("retries a directly supplied client after reconciliation failure and closes it once", async () => {
    const client = new FakeClient({ listError: new Error("list unavailable") });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(61))).rejects.toThrow("list unavailable");
    client.options.listError = undefined;
    await expect(manager.execute(command(61))).resolves.toMatchObject({ exitCode: 0 });
    await manager.dispose();

    expect(client.createCalls).toBe(1);
    expect(client.closeCalls).toBe(1);
  });

  it("reuses one sandbox per user-thread pair and serializes that thread's commands", async () => {
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

  it("keeps command preparation and cleanup inside the per-thread queue", async () => {
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

  it("does not create a sandbox when canceled during command preparation", async () => {
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
    expect(provider).toHaveBeenCalledTimes(1);
    expect(client.createCalls).toBe(0);
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

  it("allows different threads for one user to run concurrently in separate sandboxes", async () => {
    const client = new FakeClient({ runDelayMs: 20 });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await Promise.all([manager.execute(command(22, 1)), manager.execute(command(22, 2))]);

    expect(client.createCalls).toBe(2);
    expect(client.maxActive).toBeGreaterThan(1);
    expect(client.createSpecs.map((spec) => spec.metadata[METADATA_THREAD_ID]).sort()).toEqual(["1", "2"]);
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

    const sourcePath = path.join(config.AGENT_SHARED_ROOT, "users", "30", "shared", "paused-export.txt");
    const destinationPath = path.join(config.MANAGED_FILE_ROOT, "paused-export.txt");
    await fs.writeFile(sourcePath, "exported");
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await manager.exportFile({
      userId: 30,
      threadId: 1,
      guestPath: "/data/shared/paused-export.txt",
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

  it("starts the unchanged idle delay after the final activity lease releases", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const config = loadTestConfig({ OPEN_SANDBOX_IDLE_PAUSE_MS: 1000 });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(301));
    const sandboxId = client.connections[0]!.id;
    const first = manager.acquireActivityLease(301, 1);
    const second = manager.acquireActivityLease(301, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.pauseCalls).toEqual([]);

    first.release();
    first.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.pauseCalls).toEqual([]);

    const renewalsBeforeFinalRelease = client.renewCalls.length;
    second.release();
    await vi.advanceTimersByTimeAsync(999);
    expect(client.renewCalls.length).toBeGreaterThan(renewalsBeforeFinalRelease);
    expect(client.pauseCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.pauseCalls).toEqual([sandboxId]);
    await manager.dispose();
  });

  it("periodically renews the release deadline while an activity lease is held", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const config = loadTestConfig({
      OPEN_SANDBOX_IDLE_PAUSE_MS: 500,
      OPEN_SANDBOX_IDLE_RELEASE_MS: 3000,
    });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(303));
    await vi.advanceTimersByTimeAsync(0);
    const sandboxId = client.connections[0]!.id;
    const renewalsBeforeLease = client.renewCalls.length;
    const lease = manager.acquireActivityLease(303, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.renewCalls.length).toBeGreaterThan(renewalsBeforeLease);
    expect(client.renewCalls.at(-1)).toEqual([sandboxId, 3000]);
    const renewalsBeforeLeaseTimer = client.renewCalls.length;

    await vi.advanceTimersByTimeAsync(999);
    expect(client.renewCalls).toHaveLength(renewalsBeforeLeaseTimer);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.renewCalls.length).toBeGreaterThan(renewalsBeforeLeaseTimer);
    expect(client.renewCalls.at(-1)).toEqual([sandboxId, 3000]);

    const renewalsAfterFirstInterval = client.renewCalls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.renewCalls.length).toBeGreaterThan(renewalsAfterFirstInterval);
    expect(client.pauseCalls).toEqual([]);

    lease.release();
    await vi.advanceTimersByTimeAsync(0);
    const renewalsAfterRelease = client.renewCalls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(client.pauseCalls).toEqual([sandboxId]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.renewCalls).toHaveLength(renewalsAfterRelease);
    await manager.dispose();
  });

  it("keeps activity leases isolated by thread", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const config = loadTestConfig({ OPEN_SANDBOX_IDLE_PAUSE_MS: 1000 });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });

    await manager.execute(command(302, 1));
    await manager.execute(command(302, 2));
    const firstId = client.connections.find((connection) => connection.id === "sandbox-1")!.id;
    const secondId = client.connections.find((connection) => connection.id === "sandbox-2")!.id;
    const lease = manager.acquireActivityLease(302, 1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.pauseCalls).toContain(secondId);
    expect(client.pauseCalls).not.toContain(firstId);
    lease.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.pauseCalls).toContain(firstId);
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

  it("uses the remote timeout only as a backstop to the local deadline", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({ completeOnServerTimeout: true });
    const config = loadTestConfig({ OPEN_SANDBOX_INTERRUPT_GRACE_MS: 5000 });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });
    const result = manager.execute({ ...command(401), timeoutMs: 1000 });
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());

    expect(client.connections[0]?.runOptions[0]?.timeoutSeconds).toBe(6);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toMatchObject({ timedOut: true, exitCode: null });
    expect(client.connections[0]?.interruptCalls).toEqual([client.connections[0]?.lastExecutionId]);
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
    const manager = new UserOpenSandboxRuntimeManager({
      config: loadTestConfig({ OPEN_SANDBOX_IDLE_PAUSE_MS: 1000 }),
      client,
    });
    const first = manager.execute({ ...command(42), timeoutMs: 1000 });
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());
    const quarantinedId = client.connections[0]!.id;

    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toMatchObject({ timedOut: true });
    expect(client.connections[0]?.closeCalls).toBe(1);
    expect(client.connections[0]?.deleteCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.pauseCalls).not.toContain(quarantinedId);

    client.options.waitForInterrupt = false;
    client.options.interruptError = undefined;
    await expect(manager.execute(command(42))).resolves.toMatchObject({ exitCode: 0 });
    expect(client.killCalls).toContain(quarantinedId);
    expect(client.createCalls).toBe(2);
    expect(client.connections.at(-1)?.id).not.toBe(quarantinedId);
    await manager.dispose();
  });

  it("closes and quarantines a connection when execution fails after remote start", async () => {
    const executionError = new Error("execution stream failed");
    const client = new FakeClient({ runError: executionError });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(421))).rejects.toBe(executionError);

    expect(client.connections[0]?.closeCalls).toBe(1);
    expect(client.connections[0]?.deleteCalls).toEqual([]);
    const quarantinedId = client.connections[0]!.id;
    client.options.runError = undefined;
    await expect(manager.execute(command(421))).resolves.toMatchObject({ exitCode: 0 });
    expect(client.killCalls).toContain(quarantinedId);
    await manager.dispose();
  });

  it("preserves a completed sandbox when output retrieval fails", async () => {
    const outputError = new Error("output unavailable");
    const client = new FakeClient({ readBytesError: outputError });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute(command(422))).rejects.toBe(outputError);

    const sandboxId = client.connections[0]!.id;
    expect(client.killCalls).not.toContain(sandboxId);
    expect(client.connections[0]?.closeCalls).toBe(0);
    client.options.readBytesError = undefined;
    await expect(manager.execute(command(422))).resolves.toMatchObject({ exitCode: 0 });
    expect(client.createCalls).toBe(1);
    expect(client.killCalls).not.toContain(sandboxId);
    await manager.dispose();
  });

  it("removes remote command files when stdin upload creates a file and then rejects", async () => {
    const uploadError = new Error("stdin upload failed");
    const client = new FakeClient({ writeError: uploadError });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    await expect(manager.execute({ ...command(423), stdin: "partial input" })).rejects.toBe(uploadError);

    const connection = client.connections[0]!;
    expect(connection.writeEntries).toHaveLength(1);
    expect(connection.remoteFiles).toEqual(new Set());
    expect(connection.runCommands).toEqual([]);
    expect(connection.deleteCalls).toHaveLength(1);
    expect(connection.deleteCalls[0]).toEqual(expect.arrayContaining([
      connection.writeEntries[0]!.path,
      expect.stringMatching(/^\/tmp\/ai-tg-bot-stdout-/),
      expect.stringMatching(/^\/tmp\/ai-tg-bot-stderr-/),
    ]));
    expect(client.killCalls).toEqual([]);
    await manager.dispose();
  });

  it("removes remote command files when stdin upload times out", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({ writeNeverSettles: true });
    const manager = new UserOpenSandboxRuntimeManager({
      config: loadTestConfig({ OPEN_SANDBOX_CONTROL_TIMEOUT_MS: 100 }),
      client,
    });

    const execution = expect(manager.execute({ ...command(424), stdin: "partial input" }))
      .rejects.toThrow("write command stdin timed out after 100ms");
    await vi.waitFor(() => expect(client.connections[0]?.remoteFiles.size).toBe(1));
    await vi.advanceTimersByTimeAsync(100);
    await execution;

    const connection = client.connections[0]!;
    expect(connection.remoteFiles).toEqual(new Set());
    expect(connection.runCommands).toEqual([]);
    expect(connection.deleteCalls).toHaveLength(1);
    expect(connection.deleteCalls[0]).toHaveLength(3);
    await manager.dispose();
  });

  it("does not start a command when shutdown begins during stdin upload", async () => {
    const upload = deferred<void>();
    const client = new FakeClient({ writeGate: upload.promise });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    const execution = manager.execute({ ...command(425), stdin: "pending input" });
    await vi.waitFor(() => expect(client.connections[0]?.writeEntries).toHaveLength(1));

    const disposal = manager.dispose();
    upload.resolve();

    await expect(execution).rejects.toThrow("OpenSandbox runtime is shutting down");
    await expect(disposal).resolves.toBeUndefined();
    const connection = client.connections[0]!;
    expect(connection.runCommands).toEqual([]);
    expect(connection.remoteFiles).toEqual(new Set());
    expect(connection.deleteCalls).toHaveLength(1);
    expect(client.pauseCalls).toEqual([connection.id]);
  });

  it("does not upload stdin when shutdown begins during sandbox creation", async () => {
    const creation = deferred<void>();
    const client = new FakeClient({ createGate: creation.promise });
    const manager = new UserOpenSandboxRuntimeManager({ config: loadTestConfig(), client });

    const execution = manager.execute(command(426));
    await vi.waitFor(() => expect(client.createCalls).toBe(1));

    const disposal = manager.dispose();
    creation.resolve();

    await expect(execution).rejects.toThrow("OpenSandbox runtime is shutting down");
    await expect(disposal).resolves.toBeUndefined();
    const connection = client.connections[0]!;
    expect(connection.writeEntries).toEqual([]);
    expect(connection.runCommands).toEqual([]);
    expect(client.pauseCalls).toEqual([connection.id]);
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
    expect(client.connections[0]?.runCommands[0]).toContain("head -c 24");
    expect(client.connections[0]?.runCommands[0]).toContain("cat > /dev/null");
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

  it("aborts local execution before a stalled shutdown interrupt reaches its deadline", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({
      waitForInterrupt: true,
      interruptNeverSettles: true,
    });
    const config = loadTestConfig({
      OPEN_SANDBOX_CONTROL_TIMEOUT_MS: 100,
      OPEN_SANDBOX_INTERRUPT_GRACE_MS: 100,
    });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });
    const execution = manager.execute(command(451));
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());

    const disposal = expect(manager.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("interrupt command during shutdown") })],
    });
    expect(client.connections[0]?.lastRunSignal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
    await disposal;
    const sandboxId = client.connections[0]!.id;
    expect(client.killCalls).toContain(sandboxId);
    expect(client.pauseCalls).not.toContain(sandboxId);
    expect(client.connections[0]?.deleteCalls).toEqual([]);
    expect(client.closeCalls).toBe(1);
  });

  it.each([
    {
      name: "fails",
      options: { interruptError: new Error("interrupt unavailable") },
      expectedError: "interrupt unavailable",
    },
    {
      name: "has no execution id",
      options: { omitExecutionId: true },
      expectedError: "no execution id",
    },
  ])("kills rather than pauses when shutdown interrupt $name", async ({
    options,
    expectedError,
  }) => {
    const client = new FakeClient({ waitForInterrupt: true, ...options });
    const manager = new UserOpenSandboxRuntimeManager({
      config: loadTestConfig({ OPEN_SANDBOX_CONTROL_TIMEOUT_MS: 100 }),
      client,
    });
    const execution = manager.execute(command(454));
    await vi.waitFor(() => expect(client.connections[0]?.active).toBe(1));

    const disposal = expect(manager.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining(expectedError) })],
    });
    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
    await disposal;

    const sandboxId = client.connections[0]!.id;
    expect(client.killCalls).toContain(sandboxId);
    expect(client.pauseCalls).not.toContain(sandboxId);
    expect(client.connections[0]?.deleteCalls).toEqual([]);
  });

  it("keeps total shutdown work within one deadline budget", async () => {
    vi.useFakeTimers();
    const client = new FakeClient({
      waitForInterrupt: true,
      interruptNeverSettles: true,
      killNeverSettles: true,
    });
    const config = loadTestConfig({
      OPEN_SANDBOX_CONTROL_TIMEOUT_MS: 30_000,
      OPEN_SANDBOX_INTERRUPT_GRACE_MS: 30_000,
    });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });
    manager.execute(command(453)).catch(() => undefined);
    await vi.waitFor(() => expect(client.connections[0]?.lastExecutionId).toBeTruthy());

    const disposal = expect(manager.dispose()).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.killCalls).toEqual([client.connections[0]!.id]);
    await vi.advanceTimersByTimeAsync(15_000);
    await disposal;

    expect(client.pauseCalls).toEqual([]);
    expect(client.closeCalls).toBe(0);
  });

  it("bounds and runs per-thread shutdown cleanup concurrently", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const config = loadTestConfig({ OPEN_SANDBOX_CONTROL_TIMEOUT_MS: 100 });
    const manager = new UserOpenSandboxRuntimeManager({ config, client });
    await Promise.all([
      manager.execute(command(452, 1)),
      manager.execute(command(452, 2)),
    ]);
    client.options.pauseNeverSettles = true;

    const disposal = expect(manager.dispose()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining("pause sandbox during shutdown") }),
        expect.objectContaining({ message: expect.stringContaining("pause sandbox during shutdown") }),
      ],
    });
    await vi.waitFor(() => expect(client.pauseCalls).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(100);
    await disposal;
    expect(client.closeCalls).toBe(1);
  });

  it("exports only regular files beneath the current thread or shared mounts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensandbox-export-"));
    const config = loadTestConfig({
      AGENT_SHARED_ROOT: root,
      OPEN_SANDBOX_SHARED_HOST_ROOT: root,
    });
    const source = path.join(root, "users", "50", "threads", "1", "workspace", "result.txt");
    const siblingSource = path.join(root, "users", "50", "threads", "2", "workspace", "secret.txt");
    const destination = path.join(root, ".outbox", "result.txt");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(siblingSource), { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, "result");
    await fs.writeFile(siblingSource, "secret");
    const manager = new UserOpenSandboxRuntimeManager({ config, client: new FakeClient() });

    await manager.exportFile({
      userId: 50,
      threadId: 1,
      guestPath: "/data/threads/1/workspace/result.txt",
      hostDestination: destination,
      maxBytes: 1024,
    });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("result");
    await expect(manager.exportFile({
      userId: 50,
      threadId: 1,
      guestPath: "/data/threads/2/workspace/secret.txt",
      hostDestination: `${destination}.sibling`,
      maxBytes: 1024,
    })).rejects.toThrow("current thread");
    await expect(manager.exportFile({
      userId: 50,
      threadId: 1,
      guestPath: "/etc/passwd",
      hostDestination: `${destination}.bad`,
      maxBytes: 1024,
    })).rejects.toThrow("current thread");
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
  completeOnServerTimeout: boolean;
  listError?: Error;
  closeError?: Error;
  interruptError?: Error;
  interruptNeverSettles?: boolean;
  omitExecutionId?: boolean;
  killNeverSettles?: boolean;
  pauseNeverSettles?: boolean;
  runError?: Error;
  readBytesError?: Error;
  writeError?: Error;
  writeNeverSettles?: boolean;
  writeGate?: Promise<void>;
  createGate?: Promise<void>;
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
  readonly renewCalls: Array<[string, number]> = [];
  readonly createSpecs: OpenSandboxCreateSpec[] = [];
  createCalls = 0;
  closeCalls = 0;
  active = 0;
  maxActive = 0;

  constructor(options: Partial<FakeOptions> = {}) {
    this.options = {
      runDelayMs: 0,
      waitForInterrupt: false,
      completeOnServerTimeout: false,
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
    this.createSpecs.push(spec);
    const id = `sandbox-${this.createCalls}`;
    await this.options.createGate;
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
    if (this.options.pauseNeverSettles) await new Promise<void>(() => undefined);
    const current = await this.getInfo(id);
    this.infos.set(id, { ...current, state: "Paused" });
  }

  async renew(id: string, idleReleaseMs: number): Promise<void> {
    await this.getInfo(id);
    this.renewCalls.push([id, idleReleaseMs]);
  }

  async kill(id: string): Promise<void> {
    this.killCalls.push(id);
    if (this.options.killNeverSettles) await new Promise<void>(() => undefined);
    this.infos.delete(id);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.options.closeError) throw this.options.closeError;
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
  readonly remoteFiles = new Set<string>();
  readonly deleteCalls: string[][] = [];
  readonly readBytesCalls: Array<{ path: string; options?: { range?: string; offset?: number; limit?: number } }> = [];
  readonly runCommands: string[] = [];
  readonly runOptions: RunCommandOpts[] = [];
  lastExecutionId?: string;
  lastRunSignal?: AbortSignal;
  closeCalls = 0;
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

  async run(
    command: string,
    options: RunCommandOpts,
    handlers: ExecutionHandlers,
    signal?: AbortSignal,
  ) {
    this.runCommands.push(command);
    this.runOptions.push(options);
    if (command.includes("printf '\\036'")) {
      return { id: `seal-${this.id}-${Date.now()}`, exitCode: 0 };
    }
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.client.started();
    const executionId = `execution-${this.id}-${Date.now()}`;
    this.lastExecutionId = executionId;
    this.lastRunSignal = signal;
    if (!this.options.omitExecutionId) {
      await handlers.onInit?.({ id: executionId, timestamp: Date.now() });
    }
    try {
      let serverTimedOut = false;
      if (this.options.completeOnServerTimeout) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            serverTimedOut = true;
            resolve();
          }, (options.timeoutSeconds ?? 0) * 1000);
          this.interrupted = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      } else if (this.options.waitForInterrupt) {
        await new Promise<void>((resolve) => {
          this.interrupted = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } else if (this.options.runDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.runDelayMs));
      }
      if (serverTimedOut) {
        return {
          id: executionId,
          exitCode: null,
          error: { name: "TimeoutError", value: "remote command timed out" },
        };
      }
      if (this.options.runError) throw this.options.runError;
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
    if (this.options.interruptNeverSettles) await new Promise<void>(() => undefined);
    if (this.options.interruptError) throw this.options.interruptError;
    this.interrupted?.();
  }

  async writeFiles(entries: WriteEntry[]): Promise<void> {
    this.writeEntries.push(...entries);
    for (const entry of entries) this.remoteFiles.add(entry.path);
    if (this.options.writeError) throw this.options.writeError;
    if (this.options.writeNeverSettles) await new Promise<void>(() => undefined);
    await this.options.writeGate;
  }

  async readBytes(
    filePath: string,
    options?: { range?: string; offset?: number; limit?: number },
  ): Promise<Uint8Array> {
    this.readBytesCalls.push({ path: filePath, options });
    if (this.options.readBytesError) throw this.options.readBytesError;
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
    for (const filePath of paths) this.remoteFiles.delete(filePath);
  }
  pause(): Promise<void> { return this.client.pause(this.id); }
  resume(): Promise<OpenSandboxConnection> { return this.client.resume(this.id); }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function info(
  id: string,
  state: string,
  metadata: Record<string, string>,
  createdAt = new Date(),
): OpenSandboxInfo {
  return { id, state, metadata, createdAt };
}

function command(userId: number, threadId = 1): SandboxCommandRequest {
  return {
    userId,
    threadId,
    command: "bash",
    args: ["-c", "printf ok"],
    env: { TZ: "UTC" },
    stdin: "",
    workingDir: "/data",
    timeoutMs: 30_000,
    maxOutputChars: 1000,
  };
}
