import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { isAbortError, throwIfAborted } from "../files/cancel.js";
import type { Logger } from "../logger.js";
import { copySandboxFileToOutbox } from "../sandbox/exportSnapshot.js";
import {
  applySandboxCommandPreparation,
  runSandboxCommandLifecycle,
} from "../sandbox/lifecycle.js";
import {
  botAttachmentRoot,
  botSharedRoot,
  botThreadWorkspace,
  scopedGuestPathToHostPath,
} from "../sandbox/paths.js";
import type {
  CommandRuntime,
  SandboxActivityLease,
  SandboxCommandLifecycle,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileExportRequest,
} from "../sandbox/types.js";
import { isPathWithin } from "../util/paths.js";
import { quoteShellToken, shellJoin } from "../util/shell.js";
import { buildBoundedCommandCapture, commandOutputReadLimit } from "./commandCapture.js";
import type {
  OpenSandboxClient,
  OpenSandboxClientProvider,
  OpenSandboxConnection,
  OpenSandboxInfo,
} from "./client.js";
import { formatSandboxError } from "./client.js";
import {
  managedSandboxMetadata,
  managedThreadSandboxMetadata,
  METADATA_FINGERPRINT,
  METADATA_THREAD_ID,
  METADATA_USER_ID,
  openSandboxCreateSpec,
  openSandboxProvisioningFingerprint,
} from "./spec.js";

type ActiveExecution = {
  connection: OpenSandboxConnection;
  executionId?: string;
  abortController: AbortController;
};

type ThreadRuntimeState = {
  tail: Promise<void>;
  pending: number;
  activityLeases: number;
  sandboxId?: string;
  remoteState?: string;
  connection?: OpenSandboxConnection;
  active?: ActiveExecution;
  idleTimer?: NodeJS.Timeout;
  activityRenewTimer?: NodeJS.Timeout;
  quarantined?: { sandboxId: string; error: Error };
  quarantinedConnection?: OpenSandboxConnection;
  shutdownInterruptPending?: boolean;
};

type SandboxScope = {
  userId: number;
  threadId: number;
};

type ThreadOpenSandboxRuntimeManagerInput = {
  config: AppConfig;
  client?: OpenSandboxClient;
  clientProvider?: OpenSandboxClientProvider;
  logger?: Logger;
};

type OutputCapture = { text: string; truncated: boolean };
type DeadlineOutcome = { kind: "timeout" } | { kind: "aborted"; reason: unknown };

type SandboxStatePolicy = {
  stable: boolean;
  adoptable: boolean;
  killable: boolean;
};

const DEFAULT_STATE_POLICY: SandboxStatePolicy = {
  stable: false,
  adoptable: false,
  killable: false,
};
const SANDBOX_STATE_POLICIES: Record<string, SandboxStatePolicy> = {
  Pending: { stable: false, adoptable: true, killable: true },
  Running: { stable: true, adoptable: true, killable: true },
  Pausing: { stable: false, adoptable: true, killable: true },
  Paused: { stable: true, adoptable: true, killable: true },
  Resuming: { stable: false, adoptable: true, killable: true },
  Stopping: { stable: false, adoptable: true, killable: false },
  Terminated: { stable: true, adoptable: false, killable: false },
  Failed: { stable: true, adoptable: false, killable: true },
  Creating: { stable: false, adoptable: true, killable: true },
  Deleted: { stable: true, adoptable: false, killable: false },
  Error: { stable: true, adoptable: false, killable: true },
};
const OUTPUT_SENTINEL = 0x1e;
const SHUTDOWN_DEADLINE_MS = 45_000;

export class ThreadOpenSandboxRuntimeManager implements CommandRuntime {
  private readonly states = new Map<string, ThreadRuntimeState>();
  private readonly fingerprint: string;
  private client?: OpenSandboxClient;
  private retainedClient?: OpenSandboxClient;
  private clientReady?: Promise<OpenSandboxClient>;
  private disposePromise?: Promise<void>;
  private readonly closedResources = new WeakSet<object>();
  private shuttingDown = false;

  constructor(private readonly input: ThreadOpenSandboxRuntimeManagerInput) {
    this.fingerprint = openSandboxProvisioningFingerprint(input.config);
  }

  execute(
    request: SandboxCommandRequest,
    lifecycle?: SandboxCommandLifecycle,
  ): Promise<SandboxCommandResult> {
    const scope = sandboxScope(request.userId, request.threadId);
    return this.enqueue(scope, request.signal, (state) =>
      this.executeWithLifecycle(state, request, lifecycle));
  }

  exportFile(request: SandboxFileExportRequest): Promise<void> {
    const scope = sandboxScope(request.userId, request.threadId);
    return this.enqueue(scope, request.signal, async () => {
      const { scopeRoot, sourcePath } = scopedGuestPathToHostPath(
        this.input.config,
        request.userId,
        request.threadId,
        request.guestPath,
      );
      await copySandboxFileToOutbox({
        scopeRoot,
        sourcePath,
        destinationPath: request.hostDestination,
        maxBytes: request.maxBytes,
        signal: request.signal,
      });
    });
  }

  acquireActivityLease(userId: number, threadId: number): SandboxActivityLease {
    if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
    const scope = sandboxScope(userId, threadId);
    const state = this.stateFor(scope);
    this.clearIdleTimer(state);
    state.activityLeases += 1;
    if (state.activityLeases === 1) {
      this.queueActivityRenewal(scope, state);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.activityLeases = Math.max(0, state.activityLeases - 1);
        if (!this.shuttingDown && state.activityLeases === 0) {
          this.clearActivityRenewTimer(state);
          this.queueIdleMaintenance(scope, state);
        }
      },
    };
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async ensureClient(): Promise<OpenSandboxClient> {
    if (this.client) return this.client;
    if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
    const provider = this.input.client
      ? async () => this.input.client!
      : this.input.clientProvider;
    if (!provider) throw new Error("OpenSandbox command runtime is unavailable: no client provider configured");
    this.clientReady ??= provider().then(async (client) => {
      if (this.input.client) this.retainedClient = client;
      try {
        await this.reconcile(client);
        if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
        this.client = client;
        return client;
      } catch (error) {
        // A provider-created client can be replaced after failed initialization. A
        // directly supplied client retains explicit retry semantics, but must still
        // be closed if shutdown won the initialization race.
        if (!this.input.client || this.shuttingDown) {
          try {
            await this.closeOnce(
              "close client after initialization failure",
              client,
              () => client.close(),
            );
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              "OpenSandbox client initialization failed and its transport could not be closed",
            );
          }
        }
        throw error;
      }
    }).finally(() => {
      this.clientReady = undefined;
    });
    return this.clientReady;
  }

  private async reconcile(client: OpenSandboxClient): Promise<void> {
    const infos = await this.control("list managed sandboxes", client.list(managedSandboxMetadata(this.input.config)));
    const grouped = new Map<string, { scope: SandboxScope; infos: OpenSandboxInfo[] }>();
    for (const info of infos) {
      const scope = sandboxScopeFromMetadata(info);
      if (!scope) {
        if (sandboxStatePolicy(info.state).killable) {
          await this.control("remove malformed managed sandbox", client.kill(info.id));
        }
        continue;
      }
      const key = sandboxScopeKey(scope);
      const group = grouped.get(key) ?? { scope, infos: [] };
      group.infos.push(info);
      grouped.set(key, group);
    }

    for (const { scope, infos: group } of grouped.values()) {
      const current = group
        .filter((info) => info.metadata[METADATA_FINGERPRINT] === this.fingerprint && sandboxStatePolicy(info.state).adoptable)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      const adopted = current[0];
      if (adopted) {
        const state = this.stateFor(scope);
        state.sandboxId = adopted.id;
        state.remoteState = adopted.state;
        this.scheduleIdlePause(scope, state);
      }
      for (const info of group) {
        if (info.id === adopted?.id || !sandboxStatePolicy(info.state).killable) continue;
        await this.control("remove obsolete managed sandbox", client.kill(info.id));
      }
    }
  }

  private async executeWithLifecycle(
    state: ThreadRuntimeState,
    request: SandboxCommandRequest,
    lifecycle?: SandboxCommandLifecycle,
  ): Promise<SandboxCommandResult> {
    const scope = sandboxScope(request.userId, request.threadId);
    throwIfAborted(request.signal);
    await this.ensureClient();
    await ensureSandboxMountDirectories(this.input.config, scope);
    throwIfAborted(request.signal);
    return runSandboxCommandLifecycle(lifecycle, async (preparation) => {
      throwIfAborted(request.signal);
      return this.executeLocked(
        state,
        applySandboxCommandPreparation(request, preparation),
      );
    });
  }

  private async executeLocked(
    state: ThreadRuntimeState,
    request: SandboxCommandRequest,
  ): Promise<SandboxCommandResult> {
    const scope = sandboxScope(request.userId, request.threadId);
    const connection = await this.acquireConnection(state, scope);
    if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
    throwIfAborted(request.signal);
    const commandId = randomUUID();
    const stdinPath = `/tmp/ai-tg-bot-stdin-${commandId}`;
    const stdoutPath = `/tmp/ai-tg-bot-stdout-${commandId}`;
    const stderrPath = `/tmp/ai-tg-bot-stderr-${commandId}`;
    const stdout: OutputCapture = { text: "", truncated: false };
    const stderr: OutputCapture = { text: "", truncated: false };
    const abortController = new AbortController();
    const active: ActiveExecution = { connection, abortController };
    let deadline: ReturnType<typeof createDeadline> | undefined;

    try {
      await this.control("write command stdin", connection.writeFiles([{
        path: stdinPath,
        data: request.stdin,
        // OpenSandbox encodes octal permission digits as a number; 0o600 would be sent as 384.
        mode: 600,
        owner: this.input.config.OPEN_SANDBOX_USER,
        group: this.input.config.OPEN_SANDBOX_GROUP,
      }]));

      if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
      state.active = active;
      const command = buildBoundedCommandCapture({
        command: request.command,
        args: request.args,
        stdinPath,
        stdoutPath,
        stderrPath,
        maxOutputChars: request.maxOutputChars,
      });
      deadline = createDeadline(request.timeoutMs, request.signal);
      const remoteTimeoutMs = Math.min(
        Number.MAX_SAFE_INTEGER,
        request.timeoutMs + this.input.config.OPEN_SANDBOX_INTERRUPT_GRACE_MS,
      );
      let remoteExecutionCompleted = false;
      const completion = connection.run(command, {
        workingDirectory: request.workingDir,
        timeoutSeconds: Math.max(1, Math.ceil(remoteTimeoutMs / 1000)),
        uid: this.input.config.OPEN_SANDBOX_UID,
        gid: this.input.config.OPEN_SANDBOX_GID,
        envs: request.env,
      }, {
        skipAccumulation: true,
        onInit: (init) => {
          active.executionId = init.id;
        },
        // Execd's SSE events are line-oriented and do not preserve whether a chunk ended
        // with a newline. Keep them only as best-effort partial output; completed output
        // is read verbatim from the redirected files below.
        onStdout: (message) => appendOutput(stdout, message.text, request.maxOutputChars),
        onStderr: (message) => appendOutput(stderr, message.text, request.maxOutputChars),
      }, abortController.signal).then((result) => {
        remoteExecutionCompleted = true;
        return result;
      });

      try {
        const outcome = await Promise.race([
          completion.then((result) => ({ kind: "completed" as const, result })),
          deadline.promise,
        ]);
        if (outcome.kind === "completed") {
          await this.readCommandOutput(connection, stdoutPath, stderrPath, request, stdout, stderr);
          return {
            stdout: stdout.text,
            stderr: stderr.text,
            exitCode: outcome.result.exitCode ?? null,
            timedOut: false,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            ...(outcome.result.error
              ? { error: `${outcome.result.error.name}: ${outcome.result.error.value}` }
              : {}),
          };
        }

        const termination = await this.interruptExecution(state, active, completion, scope);
        if (!termination.confirmed) {
          this.quarantineConnection(
            state,
            connection,
            new Error(`OpenSandbox command termination is uncertain: ${termination.error}`),
          );
        }
        if (outcome.kind === "aborted") throw outcome.reason;
        if (termination.confirmed) {
          try {
            await this.readCommandOutput(connection, stdoutPath, stderrPath, request, stdout, stderr);
          } catch (error) {
            this.input.logger?.warn("OpenSandbox interrupted output capture failed", {
              userId: request.userId,
              threadId: request.threadId,
              error: formatSandboxError(error),
            });
          }
        }
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: null,
          timedOut: true,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          error: `timed out after ${request.timeoutMs}ms`,
        };
      } catch (error) {
        if (!isAbortError(error) && active.executionId && !remoteExecutionCompleted) {
          this.quarantineConnection(
            state,
            connection,
            new Error(`OpenSandbox execution failed after remote start: ${formatSandboxError(error)}`),
          );
        }
        throw error;
      }
    } finally {
      deadline?.cancel();
      if (state.active === active) state.active = undefined;
      abortController.abort();
      const quarantined = state.quarantined?.sandboxId === connection.id;
      if (!quarantined && !state.shutdownInterruptPending) {
        try {
          await this.control("remove command files", connection.deleteFiles([
            stdinPath,
            stdoutPath,
            stderrPath,
          ]));
        } catch (error) {
          this.input.logger?.warn("OpenSandbox command file cleanup failed", {
            userId: request.userId,
            threadId: request.threadId,
            error: formatSandboxError(error),
          });
        }
      }
      if (quarantined) {
        try {
          await this.closeOnce(
            "close quarantined sandbox connection",
            connection,
            () => connection.close(),
          );
        } catch (error) {
          this.input.logger?.warn("failed to close quarantined OpenSandbox connection", {
            userId: request.userId,
            threadId: request.threadId,
            sandboxId: connection.id,
            error: formatSandboxError(error),
          });
        } finally {
          if (state.quarantinedConnection === connection) {
            state.quarantinedConnection = undefined;
          }
        }
      }
    }
  }

  private async readCommandOutput(
    connection: OpenSandboxConnection,
    stdoutPath: string,
    stderrPath: string,
    request: SandboxCommandRequest,
    stdout: OutputCapture,
    stderr: OutputCapture,
  ): Promise<void> {
    const byteLimit = commandOutputReadLimit(request.maxOutputChars);
    await this.sealCommandOutput(connection, [stdoutPath, stderrPath], request);
    const bytes = await this.readCommandOutputBytes(connection, stdoutPath, stderrPath, byteLimit);
    replaceOutputBytes(stdout, bytes[0], byteLimit, request.maxOutputChars);
    replaceOutputBytes(stderr, bytes[1], byteLimit, request.maxOutputChars);
  }

  private readCommandOutputBytes(
    connection: OpenSandboxConnection,
    stdoutPath: string,
    stderrPath: string,
    byteLimit: number,
  ): Promise<[Uint8Array, Uint8Array]> {
    return this.control("read command output", Promise.all([
      connection.readBytes(stdoutPath, { range: `bytes=0-${byteLimit - 1}` }),
      connection.readBytes(stderrPath, { range: `bytes=0-${byteLimit - 1}` }),
    ]));
  }

  private async sealCommandOutput(
    connection: OpenSandboxConnection,
    paths: string[],
    request: SandboxCommandRequest,
  ): Promise<void> {
    const result = await this.control("seal command output", connection.run(
      paths.map((outputPath) => `printf '\\036' >> ${quoteShellToken(outputPath)}`).join("; "),
      {
        workingDirectory: "/tmp",
        timeoutSeconds: Math.max(1, Math.ceil(this.input.config.OPEN_SANDBOX_CONTROL_TIMEOUT_MS / 1000)),
        uid: this.input.config.OPEN_SANDBOX_UID,
        gid: this.input.config.OPEN_SANDBOX_GID,
        envs: request.env,
      },
      { skipAccumulation: true },
    ));
    if ((result.exitCode ?? null) !== 0 || result.error) {
      throw new Error(`failed to seal command output: ${result.error
        ? `${result.error.name}: ${result.error.value}`
        : `exit code ${String(result.exitCode)}`}`);
    }
  }

  private async interruptExecution(
    state: ThreadRuntimeState,
    active: ActiveExecution,
    completion: Promise<unknown>,
    scope: SandboxScope,
  ): Promise<{ confirmed: boolean; error?: string }> {
    if (!active.executionId) {
      active.abortController.abort();
      return { confirmed: false, error: "the server did not provide an execution id" };
    }
    try {
      await this.control("interrupt command", active.connection.interrupt(active.executionId));
      await withDeadline(
        completion.then(() => undefined, () => undefined),
        this.input.config.OPEN_SANDBOX_INTERRUPT_GRACE_MS,
        "interrupted command did not settle",
      );
      return { confirmed: true };
    } catch (error) {
      active.abortController.abort();
      this.input.logger?.warn("OpenSandbox command interruption could not be confirmed", {
        ...scope,
        executionId: active.executionId,
        error: formatSandboxError(error),
      });
      return { confirmed: false, error: formatSandboxError(error) };
    } finally {
      if (state.active === active) state.active = undefined;
    }
  }

  private async acquireConnection(
    state: ThreadRuntimeState,
    scope: SandboxScope,
  ): Promise<OpenSandboxConnection> {
    const client = await this.ensureClient();
    await this.recoverQuarantine(state, client);
    await this.refreshThreadSandbox(state, client, scope);

    if (state.sandboxId) {
      const info = await this.waitForStableState(client, state.sandboxId);
      state.remoteState = info.state;
      if (info.state === "Running") {
        await this.renewIdleRelease(client, info.id);
        state.connection = await this.control(
          "connect to sandbox",
          client.connect(info.id, this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS),
        );
        return state.connection;
      }
      if (info.state === "Paused") {
        await this.renewIdleRelease(client, info.id);
        state.connection = await this.control(
          "resume sandbox",
          client.resume(info.id, this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS),
        );
        state.remoteState = "Running";
        return state.connection;
      }
      if (info.state === "Failed" || info.state === "Error") {
        await this.control("remove failed sandbox", client.kill(info.id));
      }
      state.sandboxId = undefined;
      state.remoteState = undefined;
    }

    await ensureSandboxMountDirectories(this.input.config, scope);
    const connection = await this.control(
      "create sandbox",
      client.create(openSandboxCreateSpec(this.input.config, scope.userId, scope.threadId)),
      this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS,
    );
    state.sandboxId = connection.id;
    state.remoteState = "Running";
    state.connection = connection;
    const matches = await this.control(
      "reconcile created sandbox",
      client.list(managedThreadSandboxMetadata(this.input.config, scope.userId, scope.threadId)),
    );
    for (const duplicate of matches) {
      if (duplicate.id !== connection.id && sandboxStatePolicy(duplicate.state).killable) {
        await this.control("remove duplicate sandbox", client.kill(duplicate.id));
      }
    }
    return connection;
  }

  private async refreshThreadSandbox(
    state: ThreadRuntimeState,
    client: OpenSandboxClient,
    scope: SandboxScope,
  ): Promise<void> {
    const cached = state.connection;
    state.connection = undefined;
    if (cached) {
      try {
        await this.control("close cached sandbox connection", cached.close());
      } catch (error) {
        this.input.logger?.warn("failed to close cached OpenSandbox connection", {
          ...scope,
          sandboxId: cached.id,
          error: formatSandboxError(error),
        });
      }
    }

    const infos = await this.control(
      "refresh thread sandbox",
      client.list(managedThreadSandboxMetadata(this.input.config, scope.userId, scope.threadId)),
    );
    const current = infos
      .filter((info) => info.metadata[METADATA_FINGERPRINT] === this.fingerprint && sandboxStatePolicy(info.state).adoptable)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const adopted = current[0];

    for (const info of infos) {
      if (info.id === adopted?.id || !sandboxStatePolicy(info.state).killable) continue;
      await this.control("remove obsolete thread sandbox", client.kill(info.id));
    }

    state.sandboxId = adopted?.id;
    state.remoteState = adopted?.state;
  }

  private async waitForStableState(client: OpenSandboxClient, sandboxId: string): Promise<OpenSandboxInfo> {
    const started = Date.now();
    while (true) {
      const info = await this.control("inspect sandbox", client.getInfo(sandboxId));
      if (sandboxStatePolicy(info.state).stable) return info;
      if (Date.now() - started >= this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS) {
        throw new Error(`sandbox ${sandboxId} remained in ${info.state} past the ready timeout`);
      }
      await delay(250);
    }
  }

  private async recoverQuarantine(state: ThreadRuntimeState, client: OpenSandboxClient): Promise<void> {
    const quarantined = state.quarantined;
    if (!quarantined) return;
    try {
      await this.control("remove quarantined sandbox", client.kill(quarantined.sandboxId));
      state.quarantined = undefined;
      state.sandboxId = undefined;
      state.remoteState = undefined;
      state.quarantinedConnection = undefined;
      if (state.connection) {
        const connection = state.connection;
        await this.closeOnce(
          "close recovered quarantined sandbox connection",
          connection,
          () => connection.close(),
        ).catch(() => undefined);
      }
      state.connection = undefined;
    } catch (error) {
      throw new AggregateError([quarantined.error, error], "quarantined OpenSandbox instance could not be removed");
    }
  }

  private quarantineConnection(
    state: ThreadRuntimeState,
    connection: OpenSandboxConnection,
    error: Error,
  ): void {
    state.quarantined = { sandboxId: connection.id, error };
    state.quarantinedConnection = connection;
    state.shutdownInterruptPending = false;
    state.connection = undefined;
    state.sandboxId = connection.id;
    this.clearActivityRenewTimer(state);
  }

  private enqueue<T>(
    scope: SandboxScope,
    signal: AbortSignal | undefined,
    work: (state: ThreadRuntimeState) => Promise<T>,
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("OpenSandbox runtime is shutting down"));
    const state = this.stateFor(scope);
    this.clearIdleTimer(state);
    state.pending += 1;
    const run = state.tail.then(async () => {
      throwIfAborted(signal);
      if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
      return work(state);
    });
    state.tail = run.then(() => undefined, () => undefined).finally(async () => {
      state.pending -= 1;
      await this.tryRenewIdleRelease(scope, state);
      this.scheduleIdlePause(scope, state);
      this.scheduleActivityRenewal(scope, state);
    });
    return run;
  }

  private stateFor(scope: SandboxScope): ThreadRuntimeState {
    const key = sandboxScopeKey(scope);
    let state = this.states.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0, activityLeases: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private scheduleIdlePause(scope: SandboxScope, state: ThreadRuntimeState): void {
    if (!this.canPauseIdle(state)) return;
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      const pause = state.tail.then(async () => {
        if (!this.canPauseIdle(state)) return;
        const client = await this.ensureClient();
        if (!this.canPauseIdle(state)) return;
        const id = state.sandboxId!;
        try {
          await this.control("pause idle sandbox", client.pause(id));
          await state.connection?.close().catch(() => undefined);
          state.connection = undefined;
          state.remoteState = "Paused";
          this.input.logger?.info("paused idle OpenSandbox thread sandbox", { ...scope, sandboxId: id });
        } catch (error) {
          this.input.logger?.warn("failed to pause idle OpenSandbox thread sandbox", {
            ...scope,
            sandboxId: id,
            error: formatSandboxError(error),
          });
          this.scheduleIdlePause(scope, state);
        }
      });
      state.tail = pause.then(() => undefined, () => undefined);
    }, this.input.config.OPEN_SANDBOX_IDLE_PAUSE_MS);
  }

  private canPauseIdle(state: ThreadRuntimeState): state is ThreadRuntimeState & { sandboxId: string } {
    return !this.shuttingDown
      && state.pending === 0
      && !state.active
      && state.activityLeases === 0
      && !state.quarantined
      && Boolean(state.sandboxId)
      && state.remoteState !== "Paused";
  }

  private clearIdleTimer(state: ThreadRuntimeState): void {
    if (!state.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private scheduleActivityRenewal(scope: SandboxScope, state: ThreadRuntimeState): void {
    if (this.shuttingDown
      || state.activityLeases === 0
      || state.activityRenewTimer
      || state.quarantined
      || !state.sandboxId
      || !this.client) return;
    const renewalDelayMs = Math.max(
      1,
      Math.floor(this.input.config.OPEN_SANDBOX_IDLE_RELEASE_MS / 3),
    );
    state.activityRenewTimer = setTimeout(() => {
      state.activityRenewTimer = undefined;
      this.queueActivityRenewal(scope, state);
    }, renewalDelayMs);
  }

  private queueActivityRenewal(scope: SandboxScope, state: ThreadRuntimeState): void {
    if (this.shuttingDown
      || state.activityLeases === 0
      || state.quarantined
      || !state.sandboxId
      || !this.client) return;
    const renewal = state.tail.then(async () => {
      if (this.shuttingDown
        || state.activityLeases === 0
        || state.quarantined
        || !state.sandboxId
        || !this.client) return;
      await this.tryRenewIdleRelease(scope, state);
    });
    state.tail = renewal.then(() => undefined, () => undefined).finally(() => {
      this.scheduleActivityRenewal(scope, state);
    });
  }

  private clearActivityRenewTimer(state: ThreadRuntimeState): void {
    if (!state.activityRenewTimer) return;
    clearTimeout(state.activityRenewTimer);
    state.activityRenewTimer = undefined;
  }

  private queueIdleMaintenance(scope: SandboxScope, state: ThreadRuntimeState): void {
    const maintenance = state.tail.then(async () => {
      await this.tryRenewIdleRelease(scope, state);
      this.scheduleIdlePause(scope, state);
    });
    state.tail = maintenance.then(() => undefined, () => undefined);
  }

  private async renewIdleRelease(
    client: OpenSandboxClient,
    sandboxId: string,
  ): Promise<void> {
    await this.control(
      "renew sandbox idle release",
      client.renew(sandboxId, this.input.config.OPEN_SANDBOX_IDLE_RELEASE_MS),
    );
  }

  private async tryRenewIdleRelease(scope: SandboxScope, state: ThreadRuntimeState): Promise<void> {
    if (this.shuttingDown || state.quarantined || !state.sandboxId || !this.client) return;
    try {
      await this.renewIdleRelease(this.client, state.sandboxId);
    } catch (error) {
      this.input.logger?.warn("failed to renew OpenSandbox idle release", {
        ...scope,
        sandboxId: state.sandboxId,
        error: formatSandboxError(error),
      });
    }
  }

  private control<T>(label: string, promise: Promise<T>, timeoutMs = this.input.config.OPEN_SANDBOX_CONTROL_TIMEOUT_MS): Promise<T> {
    return withDeadline(promise, timeoutMs, `${label} timed out after ${timeoutMs}ms`);
  }

  private closeOnce(
    label: string,
    resource: object,
    close: () => Promise<void>,
    timeoutMs = this.input.config.OPEN_SANDBOX_CONTROL_TIMEOUT_MS,
  ): Promise<void> {
    if (this.closedResources.has(resource)) return Promise.resolve();
    this.closedResources.add(resource);
    return this.control(label, Promise.resolve().then(close), timeoutMs);
  }

  private async disposeInternal(): Promise<void> {
    this.shuttingDown = true;
    const states = [...this.states.values()];
    for (const state of states) {
      this.clearIdleTimer(state);
      this.clearActivityRenewTimer(state);
    }
    const errors: unknown[] = [];
    const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
    const collectControlError = async (
      label: string,
      operation: () => Promise<unknown>,
      timeoutMs = this.input.config.OPEN_SANDBOX_CONTROL_TIMEOUT_MS,
    ): Promise<unknown | undefined> => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const error = new Error(`${label} skipped because the OpenSandbox shutdown deadline expired`);
        errors.push(error);
        return error;
      }
      try {
        await this.control(
          label,
          Promise.resolve().then(operation),
          Math.min(timeoutMs, remainingMs),
        );
        return undefined;
      } catch (error) {
        errors.push(error);
        return error;
      }
    };
    const collectCloseError = (
      label: string,
      resource: object,
      close: () => Promise<void>,
    ): Promise<unknown | undefined> => collectControlError(label, async () => {
      if (this.closedResources.has(resource)) return;
      this.closedResources.add(resource);
      await close();
    });
    const client = this.client ?? this.retainedClient;
    const handledQuarantines = new Set<ThreadRuntimeState>();

    await Promise.all(states.map(async (state) => {
      const active = state.active;
      if (!active) return;
      // Abort the local transport before waiting on the control plane so a stalled
      // interrupt cannot keep command execution alive until the shutdown deadline.
      state.shutdownInterruptPending = true;
      active.abortController.abort();
      let interruptionError: unknown;
      if (active.executionId) {
        interruptionError = await collectControlError(
          "interrupt command during shutdown",
          () => active.connection.interrupt(active.executionId!),
        );
      } else {
        interruptionError = new Error(
          "active OpenSandbox command had no execution id during shutdown",
        );
        errors.push(interruptionError);
      }
      if (interruptionError) {
        this.quarantineConnection(
          state,
          active.connection,
          new Error(
            `OpenSandbox command interruption during shutdown could not be confirmed: ${formatSandboxError(interruptionError)}`,
          ),
        );
        const cleanup: Promise<unknown>[] = [
          collectCloseError(
            "close quarantined sandbox connection during shutdown",
            active.connection,
            () => active.connection.close(),
          ),
        ];
        if (client) {
          cleanup.push(collectControlError(
            "remove quarantined sandbox during shutdown",
            () => client.kill(active.connection.id),
          ));
          handledQuarantines.add(state);
        }
        await Promise.all(cleanup);
      } else {
        state.shutdownInterruptPending = false;
      }
    }));
    await Promise.all(states.map(async (state) => {
      await collectControlError(
        "thread execution queue did not stop",
        () => state.tail,
        this.input.config.OPEN_SANDBOX_INTERRUPT_GRACE_MS,
      );
    }));

    if (client) {
      await Promise.all(states.map(async (state) => {
        const cleanup: Promise<unknown>[] = [];
        if (state.quarantined) {
          if (!handledQuarantines.has(state)) {
            cleanup.push(collectControlError(
              "remove quarantined sandbox during shutdown",
              () => client.kill(state.quarantined!.sandboxId),
            ));
          }
        } else if (state.sandboxId && state.remoteState !== "Paused") {
          cleanup.push(collectControlError(
            "pause sandbox during shutdown",
            () => client.pause(state.sandboxId!),
          ));
        }
        const connection = state.quarantinedConnection ?? state.connection;
        if (connection) {
          cleanup.push(collectCloseError(
            "close sandbox connection during shutdown",
            connection,
            () => connection.close(),
          ));
        }
        await Promise.all(cleanup);
      }));
      await collectCloseError(
        "close OpenSandbox client during shutdown",
        client,
        () => client.close(),
      );
    }
    if (errors.length) throw new AggregateError(errors, "OpenSandbox runtime disposal failed");
  }
}

function sandboxScope(userId: number, threadId: number): SandboxScope {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error(`invalid user id: ${userId}`);
  if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error(`invalid thread id: ${threadId}`);
  return { userId, threadId };
}

function sandboxScopeFromMetadata(info: OpenSandboxInfo): SandboxScope | undefined {
  try {
    return sandboxScope(
      Number(info.metadata[METADATA_USER_ID]),
      Number(info.metadata[METADATA_THREAD_ID]),
    );
  } catch {
    return undefined;
  }
}

function sandboxScopeKey(scope: SandboxScope): string {
  return `${scope.userId}:${scope.threadId}`;
}

async function ensureSandboxMountDirectories(config: AppConfig, scope: SandboxScope): Promise<void> {
  const sharedRoot = path.resolve(config.AGENT_SHARED_ROOT);
  await fs.mkdir(sharedRoot, { recursive: true, mode: 0o770 });
  await assertPlainDirectory(sharedRoot);

  const user = String(scope.userId);
  const thread = String(scope.threadId);
  await ensurePlainDirectoryChain(sharedRoot, ["users", user, "threads", thread, "workspace"]);
  await ensurePlainDirectoryChain(sharedRoot, ["users", user, "threads", thread, "attachments"]);
  await ensurePlainDirectoryChain(sharedRoot, ["users", user, "shared"]);

  const expected = [
    botThreadWorkspace(config, scope.userId, scope.threadId),
    botAttachmentRoot(config, scope.userId, scope.threadId),
    botSharedRoot(config, scope.userId),
  ].map((directory) => path.resolve(directory));
  if (expected.some((directory) => !isPathWithin(sharedRoot, directory))) {
    throw new Error("sandbox mount directory escapes AGENT_SHARED_ROOT");
  }
}

async function ensurePlainDirectoryChain(root: string, segments: string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o770 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertPlainDirectory(current);
  }
}

async function assertPlainDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`sandbox mount path is not a plain directory: ${directory}`);
  }
}

function replaceOutputBytes(
  capture: OutputCapture,
  bytes: Uint8Array,
  byteLimit: number,
  maxChars: number,
): void {
  const complete = bytes.length < byteLimit && bytes.at(-1) === OUTPUT_SENTINEL;
  if (!complete && bytes.length < byteLimit) {
    throw new Error("OpenSandbox command output is missing its completion sentinel");
  }
  const outputBytes = complete ? bytes.subarray(0, -1) : bytes;
  capture.text = "";
  capture.truncated = !complete;
  appendOutput(capture, new TextDecoder().decode(outputBytes), maxChars);
}

function appendOutput(capture: OutputCapture, chunk: string, maxChars: number): void {
  const remaining = Math.max(0, maxChars - capture.text.length);
  if (chunk.length > remaining) capture.truncated = true;
  if (remaining > 0) capture.text += chunk.slice(0, remaining);
}

function createDeadline(timeoutMs: number, signal?: AbortSignal): { promise: Promise<DeadlineOutcome>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<DeadlineOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (signal) {
      onAbort = () => resolve({ kind: "aborted", reason: abortReason(signal) });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sandboxStatePolicy(state: string): SandboxStatePolicy {
  return SANDBOX_STATE_POLICIES[state] ?? DEFAULT_STATE_POLICY;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
}
