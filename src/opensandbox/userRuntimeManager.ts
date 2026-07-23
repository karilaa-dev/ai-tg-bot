import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { copySandboxFileToOutbox } from "../sandbox/exportSnapshot.js";
import { botUserRoot } from "../sandbox/paths.js";
import type {
  CommandRuntime,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileExportRequest,
} from "../sandbox/types.js";
import type {
  OpenSandboxClient,
  OpenSandboxClientProvider,
  OpenSandboxConnection,
  OpenSandboxInfo,
} from "./client.js";
import { formatSandboxError } from "./client.js";
import {
  managedSandboxMetadata,
  METADATA_FINGERPRINT,
  METADATA_USER_ID,
  openSandboxCreateSpec,
  openSandboxProvisioningFingerprint,
  userSandboxMetadata,
} from "./spec.js";

type ActiveExecution = {
  connection: OpenSandboxConnection;
  executionId?: string;
  abortController: AbortController;
};

type UserRuntimeState = {
  tail: Promise<void>;
  pending: number;
  sandboxId?: string;
  remoteState?: string;
  connection?: OpenSandboxConnection;
  active?: ActiveExecution;
  idleTimer?: NodeJS.Timeout;
  quarantined?: { sandboxId: string; error: Error };
};

type UserOpenSandboxRuntimeManagerInput = {
  config: AppConfig;
  client?: OpenSandboxClient;
  clientProvider?: OpenSandboxClientProvider;
  logger?: Logger;
};

type OutputCapture = { text: string; truncated: boolean };
type DeadlineOutcome = { kind: "timeout" } | { kind: "aborted"; reason: unknown };

const STABLE_STATES = new Set(["Running", "Paused", "Deleted", "Error"]);
const ADOPTABLE_STATES = new Set(["Running", "Paused", "Creating", "Pausing", "Resuming"]);

export class UserOpenSandboxRuntimeManager implements CommandRuntime {
  private readonly states = new Map<number, UserRuntimeState>();
  private readonly fingerprint: string;
  private client?: OpenSandboxClient;
  private clientReady?: Promise<OpenSandboxClient>;
  private disposePromise?: Promise<void>;
  private shuttingDown = false;

  constructor(private readonly input: UserOpenSandboxRuntimeManagerInput) {
    this.fingerprint = openSandboxProvisioningFingerprint(input.config);
  }

  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return this.enqueue(request.userId, request.signal, (state) => this.executeLocked(state, request));
  }

  exportFile(request: SandboxFileExportRequest): Promise<void> {
    return this.enqueue(request.userId, request.signal, async () => {
      const userRoot = botUserRoot(this.input.config, request.userId);
      const sourcePath = guestPathToHostPath(userRoot, request.guestPath);
      await copySandboxFileToOutbox({
        userRoot,
        sourcePath,
        destinationPath: request.hostDestination,
        maxBytes: request.maxBytes,
        signal: request.signal,
      });
    });
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
      await this.reconcile(client);
      if (this.shuttingDown) {
        await client.close();
        throw new Error("OpenSandbox runtime is shutting down");
      }
      this.client = client;
      return client;
    }).finally(() => {
      this.clientReady = undefined;
    });
    return this.clientReady;
  }

  private async reconcile(client: OpenSandboxClient): Promise<void> {
    const infos = await this.control("list managed sandboxes", client.list(managedSandboxMetadata(this.input.config)));
    const grouped = new Map<number, OpenSandboxInfo[]>();
    for (const info of infos) {
      const userId = Number(info.metadata[METADATA_USER_ID]);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        await this.control("remove malformed managed sandbox", client.kill(info.id));
        continue;
      }
      const group = grouped.get(userId) ?? [];
      group.push(info);
      grouped.set(userId, group);
    }

    for (const [userId, group] of grouped) {
      const current = group
        .filter((info) => info.metadata[METADATA_FINGERPRINT] === this.fingerprint && ADOPTABLE_STATES.has(info.state))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      const adopted = current[0];
      if (adopted) {
        const state = this.stateFor(userId);
        state.sandboxId = adopted.id;
        state.remoteState = adopted.state;
        this.scheduleIdlePause(userId, state);
      }
      for (const info of group) {
        if (info.id === adopted?.id) continue;
        await this.control("remove obsolete managed sandbox", client.kill(info.id));
      }
    }
  }

  private async executeLocked(
    state: UserRuntimeState,
    request: SandboxCommandRequest,
  ): Promise<SandboxCommandResult> {
    const connection = await this.acquireConnection(state, request.userId);
    throwIfAborted(request.signal);
    const stdinPath = `/tmp/ai-tg-bot-stdin-${randomUUID()}`;
    await this.control("write command stdin", connection.writeFiles([{
      path: stdinPath,
      data: request.stdin,
      mode: 600,
      owner: this.input.config.OPEN_SANDBOX_USER,
      group: this.input.config.OPEN_SANDBOX_GROUP,
    }]));

    const stdout: OutputCapture = { text: "", truncated: false };
    const stderr: OutputCapture = { text: "", truncated: false };
    const abortController = new AbortController();
    const active: ActiveExecution = { connection, abortController };
    state.active = active;
    const command = `${shellJoin([request.command, ...request.args])} < ${quoteShellToken(stdinPath)}`;
    const completion = connection.run(command, {
      workingDirectory: request.workingDir,
      timeoutSeconds: Math.max(1, Math.ceil(request.timeoutMs / 1000)),
      uid: this.input.config.OPEN_SANDBOX_UID,
      gid: this.input.config.OPEN_SANDBOX_GID,
      envs: request.env,
    }, {
      skipAccumulation: true,
      onInit: (init) => {
        active.executionId = init.id;
      },
      onStdout: (message) => appendOutput(stdout, streamLine(message.text), request.maxOutputChars),
      onStderr: (message) => appendOutput(stderr, streamLine(message.text), request.maxOutputChars),
    }, abortController.signal);
    const deadline = createDeadline(request.timeoutMs, request.signal);

    try {
      const outcome = await Promise.race([
        completion.then((result) => ({ kind: "completed" as const, result })),
        deadline.promise,
      ]);
      if (outcome.kind === "completed") {
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

      const termination = await this.interruptExecution(state, active, completion, request.userId);
      if (!termination.confirmed) {
        state.quarantined = {
          sandboxId: connection.id,
          error: new Error(`OpenSandbox command termination is uncertain: ${termination.error}`),
        };
        state.connection = undefined;
        state.sandboxId = connection.id;
      }
      if (outcome.kind === "aborted") throw outcome.reason;
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
      if (!isAbortError(error) && active.executionId) {
        state.quarantined = {
          sandboxId: connection.id,
          error: new Error(`OpenSandbox execution failed after remote start: ${formatSandboxError(error)}`),
        };
        state.connection = undefined;
        state.sandboxId = connection.id;
      }
      throw error;
    } finally {
      deadline.cancel();
      if (state.active === active) state.active = undefined;
      abortController.abort();
      try {
        await this.control("remove command stdin", connection.deleteFiles([stdinPath]));
      } catch (error) {
        this.input.logger?.warn("OpenSandbox stdin cleanup failed", {
          userId: request.userId,
          error: formatSandboxError(error),
        });
      }
    }
  }

  private async interruptExecution(
    state: UserRuntimeState,
    active: ActiveExecution,
    completion: Promise<unknown>,
    userId: number,
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
        userId,
        executionId: active.executionId,
        error: formatSandboxError(error),
      });
      return { confirmed: false, error: formatSandboxError(error) };
    } finally {
      if (state.active === active) state.active = undefined;
    }
  }

  private async acquireConnection(state: UserRuntimeState, userId: number): Promise<OpenSandboxConnection> {
    const client = await this.ensureClient();
    await this.recoverQuarantine(state, client);
    if (state.connection) return state.connection;

    if (state.sandboxId) {
      const info = await this.waitForStableState(client, state.sandboxId);
      state.remoteState = info.state;
      if (info.state === "Running") {
        state.connection = await this.control(
          "connect to sandbox",
          client.connect(info.id, this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS),
        );
        return state.connection;
      }
      if (info.state === "Paused") {
        state.connection = await this.control(
          "resume sandbox",
          client.resume(info.id, this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS),
        );
        state.remoteState = "Running";
        return state.connection;
      }
      if (info.state === "Error") {
        await this.control("remove failed sandbox", client.kill(info.id));
      }
      state.sandboxId = undefined;
      state.remoteState = undefined;
    }

    await fs.mkdir(botUserRoot(this.input.config, userId), { recursive: true, mode: 0o770 });
    const connection = await this.control(
      "create sandbox",
      client.create(openSandboxCreateSpec(this.input.config, userId)),
      this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS,
    );
    state.sandboxId = connection.id;
    state.remoteState = "Running";
    state.connection = connection;
    const matches = await this.control(
      "reconcile created sandbox",
      client.list(userSandboxMetadata(this.input.config, userId, this.fingerprint)),
    );
    for (const duplicate of matches) {
      if (duplicate.id !== connection.id) await this.control("remove duplicate sandbox", client.kill(duplicate.id));
    }
    return connection;
  }

  private async waitForStableState(client: OpenSandboxClient, sandboxId: string): Promise<OpenSandboxInfo> {
    const started = Date.now();
    while (true) {
      const info = await this.control("inspect sandbox", client.getInfo(sandboxId));
      if (STABLE_STATES.has(info.state)) return info;
      if (Date.now() - started >= this.input.config.OPEN_SANDBOX_READY_TIMEOUT_MS) {
        throw new Error(`sandbox ${sandboxId} remained in ${info.state} past the ready timeout`);
      }
      await delay(250);
    }
  }

  private async recoverQuarantine(state: UserRuntimeState, client: OpenSandboxClient): Promise<void> {
    const quarantined = state.quarantined;
    if (!quarantined) return;
    try {
      await this.control("remove quarantined sandbox", client.kill(quarantined.sandboxId));
      state.quarantined = undefined;
      state.sandboxId = undefined;
      state.remoteState = undefined;
      if (state.connection) await state.connection.close().catch(() => undefined);
      state.connection = undefined;
    } catch (error) {
      throw new AggregateError([quarantined.error, error], "quarantined OpenSandbox instance could not be removed");
    }
  }

  private enqueue<T>(
    userId: number,
    signal: AbortSignal | undefined,
    work: (state: UserRuntimeState) => Promise<T>,
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("OpenSandbox runtime is shutting down"));
    const state = this.stateFor(userId);
    this.clearIdleTimer(state);
    state.pending += 1;
    const run = state.tail.then(async () => {
      throwIfAborted(signal);
      if (this.shuttingDown) throw new Error("OpenSandbox runtime is shutting down");
      return work(state);
    });
    state.tail = run.then(() => undefined, () => undefined).finally(() => {
      state.pending -= 1;
      this.scheduleIdlePause(userId, state);
    });
    return run;
  }

  private stateFor(userId: number): UserRuntimeState {
    let state = this.states.get(userId);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 };
      this.states.set(userId, state);
    }
    return state;
  }

  private scheduleIdlePause(userId: number, state: UserRuntimeState): void {
    if (this.shuttingDown || state.pending > 0 || state.active || !state.sandboxId || state.remoteState === "Paused") return;
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      const pause = state.tail.then(async () => {
        if (this.shuttingDown || state.pending > 0 || state.active || !state.sandboxId || state.remoteState === "Paused") return;
        const client = await this.ensureClient();
        const id = state.sandboxId;
        try {
          await this.control("pause idle sandbox", client.pause(id));
          await state.connection?.close().catch(() => undefined);
          state.connection = undefined;
          state.remoteState = "Paused";
          this.input.logger?.info("paused idle OpenSandbox user sandbox", { userId, sandboxId: id });
        } catch (error) {
          this.input.logger?.warn("failed to pause idle OpenSandbox user sandbox", {
            userId,
            sandboxId: id,
            error: formatSandboxError(error),
          });
          this.scheduleIdlePause(userId, state);
        }
      });
      state.tail = pause.then(() => undefined, () => undefined);
    }, this.input.config.OPEN_SANDBOX_IDLE_PAUSE_MS);
  }

  private clearIdleTimer(state: UserRuntimeState): void {
    if (!state.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private control<T>(label: string, promise: Promise<T>, timeoutMs = this.input.config.OPEN_SANDBOX_CONTROL_TIMEOUT_MS): Promise<T> {
    return withDeadline(promise, timeoutMs, `${label} timed out after ${timeoutMs}ms`);
  }

  private async disposeInternal(): Promise<void> {
    this.shuttingDown = true;
    const states = [...this.states.values()];
    for (const state of states) this.clearIdleTimer(state);
    const errors: unknown[] = [];

    await Promise.all(states.map(async (state) => {
      const active = state.active;
      if (!active) return;
      try {
        if (active.executionId) await active.connection.interrupt(active.executionId);
        active.abortController.abort();
      } catch (error) {
        errors.push(error);
      }
    }));
    await Promise.all(states.map(async (state) => {
      try {
        await withDeadline(state.tail, this.input.config.OPEN_SANDBOX_INTERRUPT_GRACE_MS, "user execution queue did not stop");
      } catch (error) {
        errors.push(error);
      }
    }));

    const client = this.client;
    if (client) {
      for (const state of states) {
        try {
          if (state.quarantined) {
            await client.kill(state.quarantined.sandboxId);
          } else if (state.sandboxId && state.remoteState !== "Paused") {
            await client.pause(state.sandboxId);
          }
          await state.connection?.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await client.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "OpenSandbox runtime disposal failed");
  }
}

export function shellJoin(tokens: string[]): string {
  return tokens.map(quoteShellToken).join(" ");
}

export function quoteShellToken(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function guestPathToHostPath(userRoot: string, guestPath: string): string {
  const normalized = path.posix.normalize(guestPath);
  if (normalized !== "/data" && !normalized.startsWith("/data/")) {
    throw new Error("created file must be inside /data");
  }
  const relative = path.posix.relative("/data", normalized);
  const candidate = path.resolve(userRoot, ...relative.split("/").filter(Boolean));
  const root = path.resolve(userRoot);
  const relation = path.relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${path.sep}`)) throw new Error("created file path escapes the user root");
  return candidate;
}

function streamLine(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function stableUserSandboxId(userId: number, fingerprint: string): string {
  return createHash("sha256").update(`${userId}:${fingerprint}`).digest("hex").slice(0, 16);
}
