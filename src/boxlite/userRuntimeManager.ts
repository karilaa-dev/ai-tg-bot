import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_BOXLITE_GUEST_USER, type AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { formatBoxliteError } from "./client.js";
import { botUserRoot } from "./paths.js";
import type {
  BoxClient,
  BoxClientProvider,
  BoxCommandRequest,
  BoxCommandResult,
  BoxCreateOptions,
  BoxExecution,
  BoxFileExportRequest,
  BoxHandle,
  BoxOutputStream,
  CommandRuntime,
} from "./types.js";

type QuarantinedBox = {
  error: Error;
  idOrName: string;
};

type UserRuntimeState = {
  tail: Promise<void>;
  box?: BoxHandle;
  active?: BoxExecution;
  idleTimer?: NodeJS.Timeout;
  cleanedBoxName?: string;
  quarantined?: QuarantinedBox;
  pending: number;
};

type UserBoxRuntimeManagerInput = {
  config: AppConfig;
  client?: BoxClient;
  clientProvider?: BoxClientProvider;
  logger?: Logger;
};

type OutputCapture = {
  text: string;
  truncated: boolean;
  error?: string;
};

type ExecutionCompletion = {
  kind: "completed";
  exitCode: number;
  waitError?: string;
  waitRejected: boolean;
  stdinError?: string;
};

type DeadlineOutcome =
  | { kind: "timeout" }
  | { kind: "aborted"; reason: unknown };

type ExecutionDeadline = {
  promise: Promise<DeadlineOutcome>;
  cancel(): void;
};

const BOX_LAYOUT_VERSION = 2;
const MAX_BOX_FILE_BYTES = 1024 * 1024 * 1024;
const STOPPED_HANDLE_INVALIDATION = "Handle invalidated after stop()";
const TERMINATION_GRACE_MS = 5_000;
const EXPORT_SNAPSHOT_SCRIPT = `
import os
import stat
import sys

source, target, limit_text = sys.argv[1:4]
limit = int(limit_text)
try:
    source_fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
except FileNotFoundError:
    sys.exit(44)
except OSError:
    sys.exit(45)

try:
    if not stat.S_ISREG(os.fstat(source_fd).st_mode):
        sys.exit(45)
    target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    total = 0
    try:
        while total <= limit:
            chunk = os.read(source_fd, min(1048576, limit + 1 - total))
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                view = view[os.write(target_fd, view):]
            total += len(chunk)
    finally:
        os.close(target_fd)
finally:
    os.close(source_fd)

if total > limit:
    os.unlink(target)
    sys.exit(46)
print(total)
`.trim();

export class UserBoxRuntimeManager implements CommandRuntime {
  private readonly states = new Map<number, UserRuntimeState>();
  private readonly provisioningFingerprint: string;
  private client?: BoxClient;
  private clientReady?: Promise<BoxClient>;
  private disposePromise?: Promise<void>;
  private shuttingDown = false;

  constructor(private readonly input: UserBoxRuntimeManagerInput) {
    this.provisioningFingerprint = boxProvisioningFingerprint(input.config);
  }

  execute(request: BoxCommandRequest): Promise<BoxCommandResult> {
    return this.enqueue(request.userId, request.signal, (state) => this.executeLocked(state, request));
  }

  exportFile(request: BoxFileExportRequest): Promise<void> {
    return this.enqueue(request.userId, request.signal, async (state) => {
      const snapshotPath = await this.prepareExportSnapshot(state, request);
      let failure: unknown;
      try {
        const box = await this.acquireBox(state, request.userId);
        throwIfAborted(request.signal);
        const copy = this.control("copy file out", box.copyOut(snapshotPath, request.hostDestination));
        try {
          await withAbortSignal(copy, request.signal);
          throwIfAborted(request.signal);
        } catch (error) {
          await this.stopUncertainBox(state, box, request.userId, "file export failed");
          throw error;
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          await this.removeExportSnapshot(state, request.userId, snapshotPath);
        } catch (cleanupError) {
          if (failure !== undefined) {
            throw new AggregateError([failure, cleanupError], "file export and guest snapshot cleanup both failed");
          }
          throw cleanupError;
        }
      }
    });
  }

  private async reconcile(client: BoxClient): Promise<void> {
    try {
      const boxes = await this.control("list boxes", client.listInfo());
      const running = boxes.filter(
        (box) => box.running && box.name?.startsWith(`${this.input.config.BOXLITE_BOX_NAME_PREFIX}-u`),
      );
      const results = await Promise.allSettled(running.map(async (info) => {
        const box = await this.control("reattach orphaned box", client.get(info.name ?? info.id));
        if (box) await this.control("stop orphaned box", box.stop());
      }));
      const failures = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        return [{
          box: running[index]?.name ?? running[index]?.id,
          error: formatBoxliteError(result.reason),
        }];
      });
      const stopped = results.length - failures.length;
      if (stopped > 0 || failures.length > 0) {
        this.input.logger?.info("BoxLite orphan reconciliation complete", {
          stopped,
          failed: failures.length,
        });
      }
      for (const failure of failures) {
        this.input.logger?.warn("failed to stop orphaned BoxLite user box", failure);
      }
    } catch (error) {
      this.input.logger?.warn("BoxLite lazy reconciliation failed; orphaned VMs may require later cleanup", {
        error: formatBoxliteError(error),
      });
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.shuttingDown = true;
    const initializingClient = this.clientReady;
    const states = [...this.states.values()];
    const errors: Error[] = [];
    for (const state of states) this.clearIdleTimer(state);

    await Promise.all(states.map(async (state) => {
      if (!state.active) return;
      try {
        await withDeadline(state.active.kill(), TERMINATION_GRACE_MS, "active execution kill timed out");
      } catch (error) {
        errors.push(new Error(formatBoxliteError(error)));
      }
    }));
    await Promise.all(states.map(async (state) => {
      try {
        await withDeadline(state.tail, TERMINATION_GRACE_MS, "user execution queue did not stop");
      } catch (error) {
        errors.push(new Error(formatBoxliteError(error)));
      }
    }));

    let client = this.client;
    if (!client && initializingClient) {
      try {
        client = await withDeadline(
          initializingClient,
          this.input.config.BOXLITE_REQUEST_TIMEOUT_MS,
          "BoxLite runtime initialization did not finish during shutdown",
        );
      } catch {
        void initializingClient.then(
          (lateClient) => this.shutdownLateClient(lateClient),
          () => undefined,
        );
      }
    }

    if (client) {
      await Promise.all(states.map(async (state) => {
        const quarantined = state.quarantined;
        if (!quarantined) return;
        try {
          await this.control(
            "force-remove quarantined box during shutdown",
            client.remove(quarantined.idOrName, true),
          );
          state.quarantined = undefined;
        } catch (error) {
          errors.push(new Error(formatBoxliteError(error)));
        }
      }));
      await Promise.all(states.map(async (state) => {
        const box = state.box;
        if (!box) return;
        this.detachBoxForStop(state, box);
        try {
          await this.control("stop box during shutdown", box.stop());
        } catch (error) {
          errors.push(new Error(formatBoxliteError(error)));
        }
      }));
      try {
        await this.control("shut down BoxLite runtime", client.shutdown());
      } catch (error) {
        errors.push(new Error(formatBoxliteError(error)));
      }
    }

    this.states.clear();
    this.client = undefined;
    if (errors.length > 0) throw new AggregateError(errors, "BoxLite runtime cleanup failed");
  }

  private async shutdownLateClient(client: BoxClient): Promise<void> {
    try {
      await this.control("shut down late BoxLite runtime", client.shutdown());
    } catch (error) {
      this.input.logger?.error("failed to shut down BoxLite runtime after delayed initialization", {
        error: formatBoxliteError(error),
      });
    }
  }

  private enqueue<T>(
    userId: number,
    signal: AbortSignal | undefined,
    operation: (state: UserRuntimeState) => Promise<T>,
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("BoxLite runtime is shutting down."));
    const state = this.stateFor(userId);
    state.pending += 1;
    this.clearIdleTimer(state);
    const result = state.tail.catch(() => undefined).then(async () => {
      if (this.shuttingDown) throw new Error("BoxLite runtime is shutting down.");
      throwIfAborted(signal);
      await this.ensureClient();
      if (this.shuttingDown) throw new Error("BoxLite runtime is shutting down.");
      await this.recoverQuarantinedState(state, userId);
      return operation(state);
    }).catch((error) => {
      if (isAbortError(error)) throw error;
      throw toRuntimeError(error);
    });
    state.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      state.pending -= 1;
      this.scheduleIdleStop(userId, state);
    });
  }

  private ensureClient(): Promise<BoxClient> {
    if (this.client) return Promise.resolve(this.client);
    const pending = this.clientReady ??= (async () => {
      let provider = this.input.clientProvider;
      if (!provider && this.input.client) {
        const configuredClient = this.input.client;
        provider = async function provideConfiguredClient(): Promise<BoxClient> {
          return configuredClient;
        };
      }
      if (!provider) {
        throw new Error("BoxLite runtime is unavailable.");
      }

      const client = await provider();
      await this.reconcile(client);
      if (!this.shuttingDown) this.client = client;
      return client;
    })();
    return pending.finally(() => {
      if (this.clientReady === pending) this.clientReady = undefined;
    });
  }

  private async prepareExportSnapshot(state: UserRuntimeState, request: BoxFileExportRequest): Promise<string> {
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
      throw new Error(`invalid export size limit: ${request.maxBytes}`);
    }
    const snapshotPath = `/tmp/ai-tg-bot-export-${randomUUID()}`;
    const result = await this.executeLocked(state, {
      userId: request.userId,
      command: "python3",
      args: ["-c", EXPORT_SNAPSHOT_SCRIPT, request.guestPath, snapshotPath, String(request.maxBytes)],
      env: { TZ: "UTC" },
      stdin: "",
      workingDir: "/",
      timeoutMs: Math.min(10_000, this.input.config.BASH_TIMEOUT_MS),
      maxOutputChars: 128,
      signal: request.signal,
    });
    if (result.exitCode !== 0) {
      await this.removeExportSnapshot(state, request.userId, snapshotPath).catch((cleanupError) => {
        this.input.logger?.warn("failed to clean rejected BoxLite export snapshot", {
          userId: request.userId,
          error: formatBoxliteError(cleanupError),
        });
      });
    }
    if (result.timedOut) {
      throw new Error("file snapshot timed out");
    }
    if (result.error) {
      throw new Error(`cannot snapshot exported file: ${result.error}`);
    }

    switch (result.exitCode) {
      case 0:
        break;
      case 44:
        throw new Error(`file not found: ${request.guestPath}`);
      case 45:
        throw new Error("path is not a regular file");
      case 46:
        throw new Error(`file is larger than ${request.maxBytes} bytes`);
      default:
        throw new Error(`cannot snapshot exported file (exit code ${result.exitCode})`);
    }

    const size = Number(result.stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > request.maxBytes) {
      throw new Error("file snapshot returned an invalid size");
    }
    return snapshotPath;
  }

  private async removeExportSnapshot(
    state: UserRuntimeState,
    userId: number,
    snapshotPath: string,
  ): Promise<void> {
    await this.recoverQuarantinedState(state, userId);
    const result = await this.executeLocked(state, {
      userId,
      command: "rm",
      args: ["-f", "--", snapshotPath],
      env: { TZ: "UTC" },
      stdin: "",
      workingDir: "/",
      timeoutMs: Math.min(10_000, this.input.config.BASH_TIMEOUT_MS),
      maxOutputChars: 128,
    });
    if (result.timedOut || result.error || result.exitCode !== 0) {
      throw new Error(result.error ?? `snapshot cleanup failed with exit code ${result.exitCode}`);
    }
  }

  private async executeLocked(state: UserRuntimeState, request: BoxCommandRequest): Promise<BoxCommandResult> {
    const box = await this.acquireBox(state, request.userId);
    throwIfAborted(request.signal);
    const timeoutSecs = Math.max(1, Math.ceil(request.timeoutMs / 1000));
    const executionStart = box.exec(
      request.command,
      request.args,
      Object.entries(request.env),
      false,
      this.input.config.BOXLITE_GUEST_USER,
      timeoutSecs,
      request.workingDir,
    );
    let execution: BoxExecution;
    try {
      execution = await this.startExecution(executionStart, request.signal);
    } catch (error) {
      void executionStart.then(
        (lateExecution) => this.terminateDetachedExecution(lateExecution, request.userId),
        () => undefined,
      );
      await this.stopUncertainBox(state, box, request.userId, "execution start failed");
      throw error;
    }
    state.active = execution;
    if (request.signal?.aborted) {
      await this.terminateExecution(state, box, execution, request.userId);
      throw abortReason(request.signal);
    }

    const stdout: OutputCapture = { text: "", truncated: false };
    const stderr: OutputCapture = { text: "", truncated: false };
    const lifecycle = this.collectExecution(execution, request, stdout, stderr);
    const deadline = createDeadline(request.timeoutMs, request.signal);
    try {
      let completed: ExecutionCompletion | DeadlineOutcome;
      try {
        completed = await Promise.race([lifecycle, deadline.promise]);
      } catch (error) {
        await this.terminateExecution(state, box, execution, request.userId);
        if (state.quarantined) {
          throw new AggregateError(
            [error, state.quarantined.error],
            "execution failed and termination could not be confirmed",
          );
        }
        throw error;
      }
      deadline.cancel();
      if (completed.kind === "aborted") {
        await this.terminateExecution(state, box, execution, request.userId);
        throw completed.reason;
      }
      if (completed.kind === "timeout") {
        await this.terminateExecution(state, box, execution, request.userId);
        const result = timeoutResult(request, stdout, stderr);
        return state.quarantined
          ? { ...result, error: `${result.error}; ${state.quarantined.error.message}` }
          : result;
      }
      const waitError = completed.waitError;
      const daemonTimedOut = typeof waitError === "string" && /timed?\s*out|timeout/i.test(waitError);
      if (daemonTimedOut) return timeoutResult(request, stdout, stderr);
      const errors = [waitError, stdout.error, stderr.error, completed.stdinError]
        .filter((value): value is string => Boolean(value))
        .map((value) => formatBoxliteError(value));
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: errors.length > 0 || completed.waitRejected ? null : completed.exitCode,
        timedOut: false,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      };
    } finally {
      deadline.cancel();
      state.active = undefined;
    }
  }

  private async collectExecution(
    execution: BoxExecution,
    request: BoxCommandRequest,
    stdout: OutputCapture,
    stderr: OutputCapture,
  ): Promise<ExecutionCompletion> {
    const [stdoutStream, stderrStream] = await Promise.all([execution.stdout(), execution.stderr()]);
    const waitPromise = execution.wait().then(
      (result) => ({ exitCode: result.exitCode, waitError: result.errorMessage, waitRejected: false }),
      (error) => ({ exitCode: 0, waitError: formatBoxliteError(error), waitRejected: true }),
    );
    const [, , wait, stdinError] = await Promise.all([
      drainOutput(stdoutStream, request.maxOutputChars, stdout),
      drainOutput(stderrStream, request.maxOutputChars, stderr),
      waitPromise,
      writeStdin(execution, request.stdin).then(
        () => undefined,
        (error) => formatBoxliteError(error),
      ),
    ]);
    return { kind: "completed", ...wait, stdinError };
  }

  private startExecution(promise: Promise<BoxExecution>, signal?: AbortSignal): Promise<BoxExecution> {
    return withAbortSignal(this.control("start execution", promise), signal);
  }

  private async terminateExecution(
    state: UserRuntimeState,
    box: BoxHandle,
    execution: BoxExecution,
    userId: number,
  ): Promise<void> {
    let terminated = false;
    try {
      await withDeadline(execution.kill(), TERMINATION_GRACE_MS, "execution kill timed out");
      terminated = true;
    } catch (error) {
      this.input.logger?.warn("BoxLite execution kill failed", {
        userId,
        error: formatBoxliteError(error),
      });
    }
    if (!terminated) {
      const idOrName = this.detachBoxForStop(state, box);
      try {
        await this.control("stop box after failed execution kill", box.stop());
      } catch (error) {
        const message = formatBoxliteError(error);
        this.input.logger?.warn("BoxLite box stop after failed kill failed", {
          userId,
          error: message,
        });
        state.quarantined = {
          error: new Error(`BoxLite execution termination could not be confirmed: ${message}`),
          idOrName,
        };
        return;
      }
    }
    state.quarantined = undefined;
  }

  private async terminateDetachedExecution(
    execution: BoxExecution,
    userId: number,
  ): Promise<void> {
    try {
      await withDeadline(execution.kill(), TERMINATION_GRACE_MS, "late execution kill timed out");
    } catch (error) {
      this.input.logger?.warn("late BoxLite execution cleanup failed while its box was stopping", {
        userId,
        error: formatBoxliteError(error),
      });
    }
  }

  private async stopUncertainBox(
    state: UserRuntimeState,
    box: BoxHandle,
    userId: number,
    reason: string,
  ): Promise<void> {
    const idOrName = this.detachBoxForStop(state, box);
    try {
      await this.control(`stop box after ${reason}`, box.stop());
      state.quarantined = undefined;
    } catch (error) {
      const message = formatBoxliteError(error);
      this.input.logger?.warn("failed to stop BoxLite box after uncertain operation", {
        userId,
        reason,
        error: message,
      });
      state.quarantined = {
        error: new Error(`BoxLite box state is uncertain after ${reason}: ${message}`),
        idOrName,
      };
    }
  }

  private async recoverQuarantinedState(state: UserRuntimeState, userId: number): Promise<void> {
    const quarantined = state.quarantined;
    if (!quarantined) return;
    try {
      await this.control(
        "force-remove quarantined box",
        this.client!.remove(quarantined.idOrName, true),
      );
      state.quarantined = undefined;
    } catch (removeError) {
      this.input.logger?.warn("failed to force-remove quarantined BoxLite user box", {
        userId,
        error: formatBoxliteError(removeError),
      });
      throw new Error(
        `${quarantined.error.message}; recovery failed: ${formatBoxliteError(removeError)}`,
      );
    }
  }

  private detachBoxForStop(state: UserRuntimeState, box: BoxHandle): string {
    if (state.box === box) state.box = undefined;
    return box.name ?? box.id;
  }

  private async acquireBox(state: UserRuntimeState, userId: number): Promise<BoxHandle> {
    const client = this.client!;
    const name = boxNameForUser(this.input.config, userId, this.provisioningFingerprint);
    const cachedBox = state.box;
    if (cachedBox) {
      let running: boolean | undefined;
      try {
        running = cachedBox.info().running;
      } catch (error) {
        this.input.logger?.warn("cached BoxLite handle failed; reattaching", {
          userId,
          error: formatBoxliteError(error),
        });
        state.box = undefined;
      }
      if (running !== undefined) {
        let box = cachedBox;
        if (!running) {
          state.box = undefined;
          box = await this.startOrReplaceInvalidatedBox(client, cachedBox, name, userId);
        }
        state.box = box;
        await this.cleanupObsoleteBoxes(state, userId, box.name);
        return box;
      }
    }

    let box = await this.control("get box", client.get(name));
    if (box && isFailedState(box.info().status)) {
      await this.control("remove failed box", client.remove(name, true));
      box = undefined;
    }
    if (!box) {
      const created = await this.provision(
        "create box",
        client.getOrCreate(boxCreateOptions(this.input.config, userId), name),
      );
      box = created.box;
    }
    box = await this.startOrReplaceInvalidatedBox(client, box, name, userId);
    state.box = box;
    await this.cleanupObsoleteBoxes(state, userId, box.name ?? name);
    return box;
  }

  private async startOrReplaceInvalidatedBox(
    client: BoxClient,
    box: BoxHandle,
    name: string,
    userId: number,
  ): Promise<BoxHandle> {
    if (box.info().running) return box;
    try {
      await this.startBoxOrRemoveOnFailure(client, box, userId, true);
      return box;
    } catch (error) {
      if (!isStoppedHandleInvalidation(error)) throw error;
    }

    const replacement = (
      await this.provision(
        "recreate invalidated box",
        client.getOrCreate(boxCreateOptions(this.input.config, userId), name),
      )
    ).box;
    if (!replacement.info().running) {
      await this.startBoxOrRemoveOnFailure(client, replacement, userId, false);
    }
    return replacement;
  }

  private async startBoxOrRemoveOnFailure(
    client: BoxClient,
    box: BoxHandle,
    userId: number,
    allowInvalidationRetry: boolean,
  ): Promise<void> {
    try {
      await this.provision("start box", box.start());
    } catch (startError) {
      const retrying = allowInvalidationRetry && isStoppedHandleInvalidation(startError);
      this.input.logger?.warn("removing BoxLite box after restart failed", {
        userId,
        error: formatBoxliteError(startError),
        retrying,
      });
      try {
        await this.control("force-remove box after restart failed", client.remove(box.name ?? box.id, true));
      } catch (removeError) {
        throw new AggregateError(
          [startError, removeError].map(
            (error) => new Error(formatBoxliteError(error)),
          ),
          "BoxLite restart and forced removal both failed",
        );
      }
      throw startError;
    }
  }

  private async cleanupObsoleteBoxes(
    state: UserRuntimeState,
    userId: number,
    currentName: string | undefined,
  ): Promise<void> {
    if (!currentName || state.cleanedBoxName === currentName) return;
    const client = this.client!;
    const userPrefix = `${this.input.config.BOXLITE_BOX_NAME_PREFIX}-u${userId}-`;
    try {
      const boxes = await this.control("list user boxes", client.listInfo());
      const obsolete = boxes.filter((info) => info.name?.startsWith(userPrefix) && info.name !== currentName);
      const results = await Promise.allSettled(obsolete.map(async (info) => {
        const name = info.name!;
        let stopError: unknown;
        if (info.running) {
          try {
            const oldBox = await this.control("reattach obsolete box", client.get(name));
            if (oldBox) await this.control("stop obsolete box", oldBox.stop());
          } catch (error) {
            stopError = error;
          }
        }
        try {
          await this.control("remove obsolete box", client.remove(name, true));
        } catch (removeError) {
          if (stopError === undefined) throw removeError;
          throw new AggregateError(
            [stopError, removeError].map(
              (error) => new Error(formatBoxliteError(error)),
            ),
            "obsolete BoxLite box stop and removal both failed",
          );
        }
        if (stopError !== undefined) {
          this.input.logger?.warn("force-removed obsolete BoxLite box after stop failed", {
            userId,
            box: name,
            error: formatBoxliteError(stopError),
          });
        }
      }));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        for (const failure of failures) {
          this.input.logger?.warn("failed to remove obsolete BoxLite user box", {
            userId,
            error: formatBoxliteError(failure.reason),
          });
        }
        return;
      }
      state.cleanedBoxName = currentName;
      if (obsolete.length > 0) {
        this.input.logger?.info("removed obsolete BoxLite user boxes", {
          userId,
          removed: obsolete.length,
        });
      }
    } catch (error) {
      this.input.logger?.warn("failed to inspect obsolete BoxLite user boxes", {
        userId,
        error: formatBoxliteError(error),
      });
    }
  }

  private provision<T>(label: string, promise: Promise<T>): Promise<T> {
    return withDeadline(
      promise,
      this.input.config.BOXLITE_PROVISION_TIMEOUT_MS,
      `${label} timed out after ${this.input.config.BOXLITE_PROVISION_TIMEOUT_MS}ms`,
    );
  }

  private control<T>(label: string, promise: Promise<T>): Promise<T> {
    return withDeadline(
      promise,
      this.input.config.BOXLITE_REQUEST_TIMEOUT_MS,
      `${label} timed out after ${this.input.config.BOXLITE_REQUEST_TIMEOUT_MS}ms`,
    );
  }

  private stateFor(userId: number): UserRuntimeState {
    let state = this.states.get(userId);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 };
      this.states.set(userId, state);
    }
    return state;
  }

  private scheduleIdleStop(userId: number, state: UserRuntimeState): void {
    if (this.shuttingDown || state.pending > 0 || state.active || !state.box) return;
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      const stopTask = state.tail.then(async () => {
        if (this.shuttingDown || state.pending > 0 || state.active || !state.box) return;
        const box = state.box;
        const idOrName = this.detachBoxForStop(state, box);
        try {
          await this.control("stop idle box", box.stop());
          state.quarantined = undefined;
          this.input.logger?.info("stopped idle BoxLite user box", { userId });
        } catch (error) {
          this.input.logger?.warn("failed to stop idle BoxLite user box", {
            userId,
            error: formatBoxliteError(error),
          });
          await this.recoverIdleStopFailure(state, userId, idOrName);
        }
      });
      state.tail = stopTask.then(() => undefined, () => undefined);
    }, this.input.config.BOXLITE_IDLE_STOP_MS);
  }

  private async recoverIdleStopFailure(
    state: UserRuntimeState,
    userId: number,
    idOrName: string,
  ): Promise<void> {
    try {
      const freshBox = await this.control(
        "reattach box after idle stop failure",
        this.client!.get(idOrName),
      );
      state.quarantined = undefined;
      if (freshBox?.info().running) state.box = freshBox;
      this.scheduleIdleStop(userId, state);
    } catch (error) {
      const message = formatBoxliteError(error);
      this.input.logger?.warn("failed to reattach BoxLite user box after idle stop failure", {
        userId,
        error: message,
      });
      state.quarantined = {
        error: new Error(`BoxLite idle stop state is uncertain: ${message}`),
        idOrName,
      };
    }
  }

  private clearIdleTimer(state: UserRuntimeState): void {
    if (!state.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
}

export function boxProvisioningFingerprint(config: AppConfig): string {
  const fingerprintInput = {
    version: BOX_LAYOUT_VERSION,
    image: config.BOXLITE_AGENT_IMAGE,
    cpus: config.BOXLITE_CPUS,
    memoryMib: config.BOXLITE_MEMORY_MIB,
    diskSizeGb: config.BOXLITE_DISK_SIZE_GB,
    maxCpuTime: boxMaxCpuTimeSeconds(config),
    sharedHostRoot: path.resolve(config.AGENT_SHARED_ROOT),
    security: "maximum-v2",
    network: "deployment-egress-v2",
    ...(config.BOXLITE_GUEST_USER === DEFAULT_BOXLITE_GUEST_USER
      ? {}
      : { guestUser: config.BOXLITE_GUEST_USER }),
  };
  return createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex").slice(0, 8);
}

function boxMaxCpuTimeSeconds(config: Pick<AppConfig, "BASH_TIMEOUT_MS">): number {
  return Math.max(1, Math.ceil(config.BASH_TIMEOUT_MS / 1000) + 5);
}

export function boxNameForUser(
  config: Pick<AppConfig, "BOXLITE_BOX_NAME_PREFIX">,
  userId: number,
  fingerprint: string,
): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`invalid user id: ${userId}`);
  }
  return `${config.BOXLITE_BOX_NAME_PREFIX}-u${userId}-${fingerprint}`;
}

export function boxCreateOptions(config: AppConfig, userId: number): BoxCreateOptions {
  return {
    image: config.BOXLITE_AGENT_IMAGE,
    cpus: config.BOXLITE_CPUS,
    memoryMib: config.BOXLITE_MEMORY_MIB,
    diskSizeGb: config.BOXLITE_DISK_SIZE_GB,
    workingDir: "/data",
    volumes: [{ hostPath: botUserRoot(config, userId), guestPath: "/data", readOnly: false }],
    network: { mode: "enabled" },
    ports: [],
    autoRemove: false,
    detach: true,
    user: config.BOXLITE_GUEST_USER,
    security: {
      jailerEnabled: true,
      seccompEnabled: true,
      maxOpenFiles: 1024,
      maxFileSize: MAX_BOX_FILE_BYTES,
      maxProcesses: 128,
      maxCpuTime: boxMaxCpuTimeSeconds(config),
      networkEnabled: true,
      closeFds: true,
    },
  };
}

async function writeStdin(execution: BoxExecution, value: string): Promise<void> {
  const stdin = await execution.stdin();
  try {
    if (value) await stdin.writeString(value);
  } finally {
    await stdin.close();
  }
}

async function drainOutput(stream: BoxOutputStream, maxChars: number, capture: OutputCapture): Promise<void> {
  try {
    while (true) {
      const chunk = await stream.next();
      if (chunk === null) break;
      const remaining = Math.max(0, maxChars - capture.text.length);
      if (chunk.length > remaining) capture.truncated = true;
      if (remaining > 0) capture.text += chunk.slice(0, remaining);
    }
  } catch (error) {
    capture.error = String(error);
  }
}

function timeoutResult(request: BoxCommandRequest, stdout: OutputCapture, stderr: OutputCapture): BoxCommandResult {
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: null,
    timedOut: true,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    error: `timed out after ${request.timeoutMs}ms`,
  };
}

function createDeadline(timeoutMs: number, signal?: AbortSignal): ExecutionDeadline {
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

  function cancel(): void {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }

  return { promise, cancel };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
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

function isFailedState(status: string): boolean {
  return /failed|error|dead/i.test(status);
}

function isStoppedHandleInvalidation(error: unknown): boolean {
  return String(error).includes(STOPPED_HANDLE_INVALIDATION);
}

function toRuntimeError(error: unknown): Error {
  if (error instanceof AggregateError) {
    return new AggregateError(
      Array.from(error.errors, (nested) => toRuntimeError(nested)),
      formatBoxliteError(error.message),
    );
  }
  return new Error(formatBoxliteError(error));
}
