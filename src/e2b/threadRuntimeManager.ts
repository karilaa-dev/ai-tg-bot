import { officeBundle, OFFICE_BUNDLE_PATH } from "./officeBundle.js";
import { executeSandboxCommand, runControl, runCommandResult } from "./sandboxCommandExecutor.js";
import { threadFilesRevision, syncThreadFiles, requestedFileSyncResult, type ThreadFileSync } from "./telegramFileMaterializer.js";
import { publishWebsite, websiteTarget } from "./websitePublisher.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SandboxNotFoundError } from "e2b";
import { autoRetry } from "@grammyjs/auto-retry";
import { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import { throwIfAborted, raceWithAbort } from "../files/cancel.js";
import { sha256Hex } from "../files/hash.js";
import { downloadTelegramFile } from "../files/telegram.js";
import type { Logger } from "../logger.js";
import type {
  CommandRuntime,
  PublishWebsiteRequest,
  PublishedWebsite,
  SandboxActivityLease,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileReadRequest,
  SandboxFileReadResult,
  SandboxFileWriteRequest,
  SandboxFileMaterializeRequest,
  SandboxSourceFileReadRequest,
  SandboxThreadFile,
  SandboxThreadFileSyncResult,
} from "../sandbox/types.js";
import { quoteShellToken, shellJoin } from "../util/shell.js";
import { createE2BClient, E2B_IDLE_PAUSE_MS, E2B_WEBSITE_IDLE_PAUSE_MS, FileType, type E2BClient, type E2BSandbox } from "./client.js";
import { E2B_CONTROL_TMP, E2B_FILE_SOURCES, E2B_RUNTIME_TMP, E2B_TELEGRAM_FILES, E2B_WORKSPACE, isSameOrDescendant, sandboxWorkspaceFile } from "./paths.js";

type SandboxScope = { userId: number; threadId: number };
type RuntimeState = {
  tail: Promise<void>;
  leases: number;
  websiteSandboxId?: string;
  websiteIdleUntil?: number;
  websitePublishedPending?: boolean;
  threadFilesSync?: ThreadFileSync;
  connection?: E2BSandbox;
  sandboxId?: string;
  continuousStartedAt?: number;
  toolboxValidatedSandboxId?: string;
  sourcePruning?: { sandboxId: string; at: number };
  renewTimer?: NodeJS.Timeout;
};

type FileSourceInventoryEntry = {
  canonicalPath: string;
  size: number;
  modifiedAtMs: number;
};

// readWorkspaceFile() returns the immutable source before the caller can attach
// that source to its database file row. Keep a short registration window so a
// concurrent sandbox operation cannot prune the snapshot in between.
const FILE_SOURCE_REGISTRATION_GRACE_MS = 5 * 60_000;

function e2bSnapshotPath(locatorJson: string): string | undefined {
  try {
    const locator: unknown = JSON.parse(locatorJson);
    if (!locator || typeof locator !== "object" || Array.isArray(locator)) return undefined;
    const candidate = (locator as Record<string, unknown>).path;
    if (typeof candidate !== "string") return undefined;
    const normalized = path.posix.normalize(candidate);
    if (path.posix.dirname(normalized) !== E2B_FILE_SOURCES) return undefined;
    if (!/^[a-f0-9]{64}$/i.test(path.posix.basename(normalized))) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

const RENEW_INTERVAL_MS = 60_000;
const CONTINUOUS_ROTATE_MS = 55 * 60_000;
const ROTATION_GUARD_MS = 5 * 60_000;
const MAX_FOREGROUND_COMMAND_MS = 45 * 60_000;

interface ThreadE2BSandboxRuntimeInput {
  config: AppConfig;
  repos: Repos;
  logger?: Logger;
  client?: E2BClient;
  downloadTelegramBytes?: (fileId: string, signal?: AbortSignal) => Promise<Buffer>;
}

export class ThreadE2BSandboxRuntimeManager implements CommandRuntime {
  private readonly states = new Map<string, RuntimeState>();
  private readonly client: E2BClient;
  private readonly downloadTelegramBytes: (fileId: string, signal?: AbortSignal) => Promise<Buffer>;
  private shuttingDown = false;

  constructor(private readonly input: ThreadE2BSandboxRuntimeInput) {
    this.client = input.client ?? createE2BClient(input.config);
    if (input.downloadTelegramBytes) {
      this.downloadTelegramBytes = input.downloadTelegramBytes;
    } else {
      const telegramApi = new Api(input.config.BOT_TOKEN);
      telegramApi.config.use(autoRetry());
      this.downloadTelegramBytes = async (fileId, signal) =>
        (await downloadTelegramFile({
          api: telegramApi,
          config: input.config,
          fileId,
          signal,
        })).bytes;
    }
  }

  acquireActivityLease(userId: number, threadId: number): SandboxActivityLease {
    if (this.shuttingDown) throw new Error("E2B runtime is shutting down");
    const scope = { userId, threadId };
    const state = this.stateFor(scope);
    state.leases += 1;
    this.scheduleRenewal(scope, state);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.leases = Math.max(0, state.leases - 1);
        if (state.leases !== 0) return;
        this.clearRenewal(state);
        void this.enqueue(scope, undefined, async () => {
          if (!state.connection) return;
          const sandboxId = state.sandboxId;
          const idle = this.idleTimeout(state, sandboxId, true);
          await state.connection.setTimeout(idle.timeoutMs);
          this.commitIdleTimeout(state, sandboxId, idle);
          this.input.logger?.info("E2B sandbox idle timeout armed", {
            ...scope,
            sandboxId: state.sandboxId,
            timeoutMs: idle.timeoutMs,
            website: idle.website,
          });
        }).catch((error) => {
          this.input.logger?.warn("failed to arm E2B sandbox idle timeout", {
            ...scope,
            sandboxId: state.sandboxId,
            error: String(error),
          });
        });
      },
    };
  }

  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      const timeoutMs = Math.min(request.timeoutMs, MAX_FOREGROUND_COMMAND_MS);
      const prepared = await this.prepareSandbox(state, scope, request.threadFiles ?? [], timeoutMs, request.signal);
      return executeSandboxCommand(prepared.sandbox, request, timeoutMs, prepared.threadFiles, this.input.config.E2B_REQUEST_TIMEOUT_MS, this.input.logger);
    });
  }

  materializeFiles(request: SandboxFileMaterializeRequest): Promise<SandboxThreadFileSyncResult> {
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      const prepared = await this.prepareSandbox(
        state,
        scope,
        request.files,
        ROTATION_GUARD_MS,
        request.signal,
      );
      return requestedFileSyncResult(prepared.threadFiles, request.files);
    });
  }

  readWorkspaceFile(request: SandboxFileReadRequest): Promise<SandboxFileReadResult> {
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      const prepared = await this.prepareSandbox(
        state,
        scope,
        request.threadFiles ?? [],
        ROTATION_GUARD_MS,
        request.signal,
        request.preserveSource,
      );
      const candidate = sandboxWorkspaceFile(request.virtualPath);
      const result = await this.readCanonicalFile(prepared.sandbox, candidate, request.maxBytes, request.signal);
      const contentSha256 = sha256Hex(result.bytes);
      const sourceCanonicalPath = request.preserveSource
        ? await this.preserveFileSource(prepared.sandbox, result.bytes, contentSha256, request.signal)
        : null;
      return {
        sandboxId: prepared.sandbox.id,
        canonicalPath: result.canonicalPath,
        sourceCanonicalPath,
        bytes: result.bytes,
        size: result.bytes.length,
        contentSha256,
      };
    });
  }

  writeWorkspaceFile(request: SandboxFileWriteRequest): Promise<void> {
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      const { sandbox } = await this.prepareSandbox(state, scope, [], ROTATION_GUARD_MS, request.signal);
      const destination = sandboxWorkspaceFile(request.virtualPath);
      const parent = path.posix.dirname(destination);
      const created = await runCommandResult(sandbox, shellJoin(["mkdir", "-p", "--", parent]), this.input.config.E2B_REQUEST_TIMEOUT_MS, request.signal, "user");
      if (created.exitCode !== 0) throw new Error(created.stderr || "Workspace directory creation failed");
      const canonical = await runCommandResult(sandbox, shellJoin(["realpath", "--", parent]), this.input.config.E2B_REQUEST_TIMEOUT_MS, request.signal, "user");
      if (canonical.exitCode !== 0 || !isSameOrDescendant(canonical.stdout.trim(), E2B_WORKSPACE)) throw new Error("write path escapes this thread's workspace");
      const staging = path.posix.join(canonical.stdout.trim(), `.write-${randomUUID()}`);
      try {
        await sandbox.writeFile(staging, request.bytes, "user", request.signal, this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS);
        const moved = await runCommandResult(sandbox, shellJoin(["mv", "-T", "--", staging, destination]), this.input.config.E2B_REQUEST_TIMEOUT_MS, request.signal, "user");
        if (moved.exitCode !== 0) throw new Error(moved.stderr || "Workspace write failed");
      } finally {
        await sandbox.removeFile(staging, "user").catch(() => undefined);
      }
    });
  }

  readSourceFile(request: SandboxSourceFileReadRequest): Promise<Buffer> {
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      if (
        !isSameOrDescendant(request.canonicalPath, E2B_WORKSPACE)
        && !isSameOrDescendant(request.canonicalPath, E2B_FILE_SOURCES)
      ) {
        throw new Error("E2B file source path is outside this thread's durable file roots");
      }
      const mapping = await this.input.repos.threadSandboxes.get(
        this.input.config.E2B_DEPLOYMENT_ID,
        request.threadId,
      );
      if (
        !mapping
        || mapping.sandbox_id !== request.sandboxId
        || mapping.user_id !== request.userId
      ) {
        if (!mapping || mapping.sandbox_id !== request.sandboxId) {
          await this.retireSandboxFileSources(scope, request.sandboxId);
        }
        throw new Error("E2B file source does not belong to this Telegram thread");
      }
      let sandbox = state.connection?.id === request.sandboxId ? state.connection : undefined;
      if (!sandbox || !await sandbox.isRunning(request.signal).catch(() => false)) {
        const info = await this.client.getInfo(request.sandboxId, request.signal);
        sandbox = await this.client.connect(
          request.sandboxId,
          E2B_IDLE_PAUSE_MS,
          request.signal,
        );
        state.continuousStartedAt = info.state === "paused"
          ? Date.now()
          : info.startedAt.getTime();
      }
      this.rememberConnection(state, sandbox);
      try {
        return (await this.readCanonicalFile(
          sandbox,
          request.canonicalPath,
          request.maxBytes,
          request.signal,
          [E2B_WORKSPACE, E2B_FILE_SOURCES],
          "root",
        )).bytes;
      } finally {
        const idle = this.idleTimeout(state, sandbox.id, false);
        await sandbox.setTimeout(idle.timeoutMs).catch(() => undefined);
      }
    });
  }

  publishWebsite(request: PublishWebsiteRequest): Promise<PublishedWebsite> {
    const target = websiteTarget(request);
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      const prepared = await this.prepareSandbox(
        state,
        scope,
        request.threadFiles ?? [],
        ROTATION_GUARD_MS,
        request.signal,
      );
      const published = await publishWebsite(prepared.sandbox, target, this.input.config.E2B_REQUEST_TIMEOUT_MS, request.signal);
      state.websiteSandboxId = prepared.sandbox.id;
      state.websitePublishedPending = true;
      this.input.logger?.info("E2B website published", { ...scope, ...published });
      return published;
    });
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    const states = [...this.states.values()];
    for (const state of states) this.clearRenewal(state);
    await Promise.allSettled(states.map((state) => state.tail));
    await Promise.allSettled(states.map(async (state) => {
      const sandbox = state.connection;
      if (!sandbox) return;
      try {
        await sandbox.pause();
        this.input.logger?.info("paused E2B sandbox during shutdown", {
          sandboxId: sandbox.id,
        });
      } catch (error) {
        // Shutdown must continue even if E2B is temporarily unavailable. The
        // provider-side timeout remains the final fallback for this sandbox.
        this.input.logger?.warn("failed to pause E2B sandbox during shutdown", {
          sandboxId: sandbox.id,
          error: String(error),
        });
      }
    }));
    this.states.clear();
  }

  private async prepareSandbox(
    state: RuntimeState,
    scope: SandboxScope,
    files: SandboxThreadFile[],
    requestedDurationMs: number,
    signal?: AbortSignal,
    forcePrune = false,
  ): Promise<{ sandbox: E2BSandbox; threadFiles: SandboxThreadFileSyncResult }> {
    throwIfAborted(signal);
    const previousSync = state.threadFilesSync;
    const filesRevision = threadFilesRevision(files);
    const synchronizationCached = previousSync !== undefined
      && previousSync.sandboxId === state.sandboxId
      && previousSync.revision === filesRevision
      && (previousSync.retryAt === undefined || Date.now() < previousSync.retryAt);
    const projectedFileCount = synchronizationCached ? 0 : files.length;
    const restoreBatches = Math.ceil(
      projectedFileCount / this.input.config.TELEGRAM_FILE_RESTORE_CONCURRENCY,
    );
    const projectedRestoreMs = Math.min(
      CONTINUOUS_ROTATE_MS,
      restoreBatches * this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
    );
    const operationWindowMs = Math.min(
      CONTINUOUS_ROTATE_MS,
      Math.max(
        E2B_IDLE_PAUSE_MS,
        requestedDurationMs
          + projectedRestoreMs
          + ROTATION_GUARD_MS,
      ),
    );
    const connectionWindowMs = Math.max(
      operationWindowMs,
      this.idleTimeout(state, state.sandboxId, false).timeoutMs,
    );
    let sandbox = await this.acquireConnection(state, scope, connectionWindowMs, signal);
    let effectiveWindowMs = Math.max(
      operationWindowMs,
      this.idleTimeout(state, sandbox.id, false).timeoutMs,
    );
    sandbox = await this.rotateIfNeeded(state, scope, sandbox, effectiveWindowMs, signal);
    effectiveWindowMs = Math.max(
      operationWindowMs,
      this.idleTimeout(state, sandbox.id, false).timeoutMs,
    );
    await sandbox.setTimeout(effectiveWindowMs, signal);
    await this.ensureSandboxToolbox(state, scope, sandbox, signal);
    await this.ensureLayout(sandbox, signal);
    const threadFiles = await syncThreadFiles({ ...this.input, downloadTelegramBytes: this.downloadTelegramBytes }, state, scope, sandbox, files, signal);
    if (forcePrune || state.sourcePruning?.sandboxId !== sandbox.id || Date.now() - state.sourcePruning.at >= 60_000) {
      state.sourcePruning = { sandboxId: sandbox.id, at: Date.now() };
      await this.pruneFileSources(scope, sandbox, signal).catch((error) => {
        this.input.logger?.warn("failed to prune E2B file sources", {
          ...scope,
          sandboxId: sandbox.id,
          error: String(error),
        });
      });
    }
    return { sandbox, threadFiles };
  }

  private async acquireConnection(
    state: RuntimeState,
    scope: SandboxScope,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<E2BSandbox> {
    if (state.connection && await state.connection.isRunning(signal).catch(() => false)) {
      return state.connection;
    }

    const deploymentId = this.input.config.E2B_DEPLOYMENT_ID;
    const repo = this.input.repos.threadSandboxes;
    const metadata = sandboxMetadata(this.input.config, scope);
    let acquired: {
      mapping: Awaited<ReturnType<typeof repo.get>> & {};
      info: Pick<Awaited<ReturnType<E2BClient["getInfo"]>>, "sandboxId" | "state" | "startedAt">;
      created?: E2BSandbox;
    } | undefined;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      const mapping = await repo.get(deploymentId, scope.threadId);
      if (mapping) {
        try {
          acquired = {
            mapping,
            info: await this.client.getInfo(mapping.sandbox_id, signal),
          };
          break;
        } catch (error) {
          if (!isSandboxMissing(error)) throw error;
          await this.retireSandboxFileSources(scope, mapping.sandbox_id);
          await repo.removeIfMatches(deploymentId, scope.threadId, mapping.sandbox_id);
          continue;
        }
      }

      const candidates = await this.client.list(metadata, signal);
      if (candidates.length > 1) {
        throw new Error(
          `Multiple E2B sandboxes match thread ${scope.threadId}; refusing to delete or choose between them.`,
        );
      }
      if (candidates[0]) {
        const info = candidates[0];
        const winner = await repo.insertIfAbsent({
          deploymentId,
          userId: scope.userId,
          threadId: scope.threadId,
          sandboxId: info.sandboxId,
        });
        if (winner.sandbox_id === info.sandboxId) {
          acquired = { mapping: winner, info };
        } else {
          await this.preserveDiscoveredSandboxAfterMappingRace(scope, info, winner.sandbox_id);
        }
        continue;
      }

      const created = await this.client.create(metadata, signal);
      let winner: Awaited<ReturnType<typeof repo.insertIfAbsent>>;
      try {
        winner = await repo.insertIfAbsent({
          deploymentId,
          userId: scope.userId,
          threadId: scope.threadId,
          sandboxId: created.id,
        });
      } catch (error) {
        await this.client.kill(created.id).catch(() => undefined);
        throw error;
      }
      if (winner.sandbox_id !== created.id) {
        await this.removeRedundantSandbox(scope, created.id, winner.sandbox_id);
        continue;
      }
      const now = Date.now();
      acquired = {
        mapping: winner,
        info: {
          sandboxId: created.id,
          state: "running" as const,
          startedAt: new Date(now),
        },
        created,
      };
    }
    if (!acquired) {
      throw new Error(`E2B sandbox mapping for thread ${scope.threadId} did not stabilize`);
    }

    let sandbox = acquired.created;
    const resumed = acquired.info.state === "paused";
    if (!sandbox) {
      sandbox = await this.client.connect(
        acquired.mapping.sandbox_id,
        timeoutMs,
        signal,
      );
    }
    const continuousStartedAt = resumed ? Date.now() : acquired.info.startedAt.getTime();
    this.rememberConnection(state, sandbox, continuousStartedAt);
    this.input.logger?.info(acquired.created ? "E2B sandbox created" : resumed ? "E2B sandbox resumed" : "E2B sandbox connected", {
      ...scope,
      sandboxId: sandbox.id,
    });
    return sandbox;
  }

  private async removeRedundantSandbox(
    scope: SandboxScope,
    sandboxId: string,
    winnerSandboxId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.client.kill(sandboxId);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    this.input.logger?.warn("failed to remove redundant E2B sandbox after mapping race", {
      ...scope,
      sandboxId,
      winnerSandboxId,
      error: String(lastError),
    });
  }

  private async preserveDiscoveredSandboxAfterMappingRace(
    scope: SandboxScope,
    sandbox: Pick<Awaited<ReturnType<E2BClient["getInfo"]>>, "sandboxId" | "state">,
    winnerSandboxId: string,
  ): Promise<void> {
    let pauseError: unknown;
    let paused = sandbox.state === "paused";
    if (!paused) {
      try {
        const connection = await this.client.connect(sandbox.sandboxId, E2B_IDLE_PAUSE_MS);
        paused = await connection.pause();
      } catch (error) {
        pauseError = error;
      }
    }
    this.input.logger?.warn("preserved discovered E2B sandbox after ambiguous mapping race", {
      ...scope,
      sandboxId: sandbox.sandboxId,
      winnerSandboxId,
      paused,
      ...(pauseError ? { error: String(pauseError) } : {}),
    });
  }

  private async retireSandboxFileSources(scope: SandboxScope, sandboxId: string): Promise<void> {
    const removed = await this.input.repos.files.deleteE2BSourcesForSandbox(
      this.input.config.E2B_DEPLOYMENT_ID,
      sandboxId,
    );
    if (!removed) return;
    this.input.logger?.info("retired stale E2B file sources", {
      ...scope,
      sandboxId,
      sources: removed,
    });
  }

  private async pruneFileSources(
    scope: SandboxScope,
    sandbox: E2BSandbox,
    signal?: AbortSignal,
  ): Promise<void> {
    const sources = await this.input.repos.files.listE2BSourcesForSandbox(
      this.input.config.E2B_DEPLOYMENT_ID,
      sandbox.id,
    );
    const refs = await this.input.repos.files.listTelegramFileRefs(
      [...new Set(sources.map((source) => source.file_id))],
    );
    const telegramBacked = new Set(refs.map((ref) => ref.file_id));
    const byCanonicalPath = new Map<string, typeof sources>();
    for (const source of sources) {
      const canonicalPath = e2bSnapshotPath(source.locator_json);
      if (!canonicalPath) continue;
      const group = byCanonicalPath.get(canonicalPath) ?? [];
      group.push(source);
      byCanonicalPath.set(canonicalPath, group);
    }

    const inventory = await inspectFileSourceInventory(
      sandbox,
      this.input.config.E2B_REQUEST_TIMEOUT_MS,
      signal,
    );
    const inventoryPaths = new Set(inventory.map((entry) => entry.canonicalPath));

    let removedFiles = 0;
    let removedSources = 0;
    let evictedUnbackedFiles = 0;
    for (const [canonicalPath, group] of byCanonicalPath) {
      if (inventoryPaths.has(canonicalPath)) continue;
      // A missing physical snapshot can no longer satisfy its locator. Remove the
      // stale rows so normal source fallback does not keep retrying them.
      removedSources += await this.input.repos.files.deleteSourcesByIds(group.map((source) => source.id));
    }

    const retained: Array<{
      entry: FileSourceInventoryEntry;
      sources: typeof sources;
      lastUsedAt: number;
    }> = [];
    for (const entry of inventory) {
      throwIfAborted(signal);
      const group = byCanonicalPath.get(entry.canonicalPath) ?? [];
      const orphaned = group.length === 0;
      const orphanRegistrationExpired = orphaned
        && Date.now() - entry.modifiedAtMs >= FILE_SOURCE_REGISTRATION_GRACE_MS;
      const fullyTelegramBacked = group.length > 0
        && group.every((source) => telegramBacked.has(source.file_id));
      if (orphanRegistrationExpired || fullyTelegramBacked) {
        await removeFileSourceSnapshot(sandbox, entry.canonicalPath, this.input.config.E2B_REQUEST_TIMEOUT_MS, signal);
        removedFiles += 1;
        removedSources += await this.input.repos.files.deleteSourcesByIds(group.map((source) => source.id));
        continue;
      }
      retained.push({
        entry,
        sources: group,
        lastUsedAt: group.length
          ? Math.max(...group.map((source) => source.last_verified_at ?? source.created_at))
          : entry.modifiedAtMs,
      });
    }

    let retainedBytes = retained.reduce((total, item) => total + item.entry.size, 0);
    const maxBytes = this.input.config.E2B_FILE_SOURCE_MAX_BYTES;
    if (retainedBytes > maxBytes) {
      retained.sort((left, right) =>
        left.lastUsedAt - right.lastUsedAt
        || left.entry.canonicalPath.localeCompare(right.entry.canonicalPath));
      for (const item of retained) {
        if (retainedBytes <= maxBytes) break;
        throwIfAborted(signal);
        await removeFileSourceSnapshot(
          sandbox,
          item.entry.canonicalPath,
          this.input.config.E2B_REQUEST_TIMEOUT_MS,
          signal,
        );
        removedFiles += 1;
        evictedUnbackedFiles += 1;
        retainedBytes -= item.entry.size;
        removedSources += await this.input.repos.files.deleteSourcesByIds(
          item.sources.map((source) => source.id),
        );
      }
    }
    if (!removedFiles && !removedSources) return;
    this.input.logger?.info("pruned E2B file sources", {
      ...scope,
      sandboxId: sandbox.id,
      files: removedFiles,
      sources: removedSources,
      evictedUnbackedFiles,
      retainedBytes,
      maxBytes,
    });
  }

  private async rotateIfNeeded(
    state: RuntimeState,
    scope: SandboxScope,
    sandbox: E2BSandbox,
    requestedDurationMs: number,
    signal?: AbortSignal,
  ): Promise<E2BSandbox> {
    const startedAt = state.continuousStartedAt ?? Date.now();
    if (Date.now() - startedAt + requestedDurationMs + ROTATION_GUARD_MS < CONTINUOUS_ROTATE_MS) {
      return sandbox;
    }
    this.input.logger?.info("rotating E2B sandbox before continuous runtime limit", {
      ...scope,
      sandboxId: sandbox.id,
      continuousStartedAt: startedAt,
    });
    await sandbox.pause(signal);
    const resumed = await this.client.connect(
      sandbox.id,
      E2B_IDLE_PAUSE_MS,
      signal,
    );
    const now = Date.now();
    this.rememberConnection(state, resumed, now);
    return resumed;
  }

  private async ensureLayout(sandbox: E2BSandbox, signal?: AbortSignal): Promise<void> {
    const command = [
      `mkdir -p ${quoteShellToken(E2B_WORKSPACE)} ${quoteShellToken(E2B_TELEGRAM_FILES)} ${quoteShellToken(E2B_FILE_SOURCES)} ${quoteShellToken(E2B_RUNTIME_TMP)} ${quoteShellToken(E2B_CONTROL_TMP)}`,
      `chown user ${quoteShellToken(E2B_WORKSPACE)} ${quoteShellToken(E2B_RUNTIME_TMP)}`,
      `chmod 700 ${quoteShellToken(E2B_WORKSPACE)} ${quoteShellToken(E2B_RUNTIME_TMP)}`,
      `chown root ${quoteShellToken(E2B_CONTROL_TMP)}`,
      `chmod 700 ${quoteShellToken(E2B_CONTROL_TMP)}`,
      `chown root ${quoteShellToken(path.posix.dirname(E2B_FILE_SOURCES))} ${quoteShellToken(E2B_FILE_SOURCES)}`,
      `chmod 700 ${quoteShellToken(path.posix.dirname(E2B_FILE_SOURCES))} ${quoteShellToken(E2B_FILE_SOURCES)}`,
      `chown root ${quoteShellToken(E2B_TELEGRAM_FILES)}`,
      `chmod 555 ${quoteShellToken(E2B_TELEGRAM_FILES)}`,
    ].join(" && ");
    await runControl(sandbox, command, this.input.config.E2B_REQUEST_TIMEOUT_MS, signal);
  }

  private async ensureSandboxToolbox(
    state: RuntimeState,
    scope: SandboxScope,
    sandbox: E2BSandbox,
    signal?: AbortSignal,
  ): Promise<void> {
    if (state.toolboxValidatedSandboxId === sandbox.id) return;
    const script = [
      "set -euo pipefail",
      "ready() {",
      "  command -v pdf-inspector >/dev/null",
      "  [ \"$(pdf-inspector --version)\" = '1.17.0' ]",
      "  command -v pdfinfo >/dev/null",
      "  command -v pdftoppm >/dev/null",
      "  command -v magick >/dev/null",

      "}",
      "if ready; then printf 'ready'; exit 0; fi",
      "(",
      "  flock -x 9",
      "  if ready; then printf 'ready'; exit 0; fi",
      "  export DEBIAN_FRONTEND=noninteractive",
      "  apt-get update -qq",
      "  apt-get install -y --no-install-recommends poppler-utils",
      "  npm install -g --omit=dev --no-audit --no-fund '@firecrawl/pdf-inspector@1.17.0'",
      "  ready",
      "  printf 'upgraded'",
      ") 9>/tmp/ai-tg-bot-toolbox-upgrade.lock",
    ].join("\n");
    const result = await runCommandResult(
      sandbox,
      shellJoin(["bash", "-c", script]),
      this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
      signal,
      "root",
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Existing E2B sandbox toolbox upgrade failed.");
    }
    const bundle = await officeBundle();
    const installed = await runCommandResult(sandbox, "cat /opt/office/installed-revision 2>/dev/null || true", this.input.config.E2B_REQUEST_TIMEOUT_MS, signal);
    if (installed.stdout.trim() !== bundle.revision) {
      this.input.logger?.info("upgrading Office tools in existing sandbox", {...scope, sandboxId:sandbox.id});
      await sandbox.setTimeout(10 * 60_000, signal);
      const directories = [...new Set(bundle.files.map(file => path.posix.dirname(file.path)))];
      await runControl(sandbox, shellJoin(["mkdir", "-p", "--", ...directories]), this.input.config.E2B_REQUEST_TIMEOUT_MS, signal);
      for (const file of bundle.files) await sandbox.writeFile(file.path, file.bytes, "root", signal, this.input.config.E2B_REQUEST_TIMEOUT_MS);
      const upgrade = await runCommandResult(sandbox, shellJoin(["bash", `${OFFICE_BUNDLE_PATH}/install.sh`]), 8 * 60_000, signal);
      if (upgrade.exitCode !== 0) throw new Error(upgrade.stderr || "Office toolbox upgrade failed. Workspace files were preserved.");
    }
    state.toolboxValidatedSandboxId = sandbox.id;
    this.input.logger?.info(
      result.stdout.includes("upgraded") ? "upgraded existing E2B sandbox toolbox" : "validated E2B sandbox toolbox",
      { ...scope, sandboxId: sandbox.id },
    );
  }

  private async readCanonicalFile(
    sandbox: E2BSandbox,
    candidate: string,
    maxBytes: number,
    signal?: AbortSignal,
    allowedRoots: string[] = [E2B_WORKSPACE],
    realpathUser = "user",
  ): Promise<{ canonicalPath: string; bytes: Buffer }> {
    const canonicalResult = await runCommandResult(
      sandbox,
      shellJoin(["realpath", "--", candidate]),
      this.input.config.E2B_REQUEST_TIMEOUT_MS,
      signal,
      realpathUser,
    );
    const canonicalPath = canonicalResult.stdout.trim();
    if (!canonicalPath || !allowedRoots.some((root) => isSameOrDescendant(canonicalPath, root))) {
      throw new Error("file path escapes its allowed E2B roots");
    }
    const info = await sandbox.fileInfo(canonicalPath, realpathUser, signal);
    if (info.type !== FileType.FILE || info.symlinkTarget) throw new Error("path is not a regular file");
    if (info.size > maxBytes) throw new Error("file is larger than the allowed limit");
    const bytes = Buffer.from(await sandbox.readFile(
      canonicalPath,
      realpathUser,
      signal,
      this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
    ));
    if (bytes.length > maxBytes) throw new Error("file is larger than the allowed limit");
    const after = await sandbox.fileInfo(canonicalPath, realpathUser, signal);
    if (after.type !== FileType.FILE || after.symlinkTarget || after.size !== bytes.length) {
      throw new Error("file changed while it was being read");
    }
    return { canonicalPath, bytes };
  }

  private async preserveFileSource(
    sandbox: E2BSandbox,
    bytes: Buffer,
    contentSha256: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const destination = path.posix.join(E2B_FILE_SOURCES, contentSha256);
    try {
      const info = await sandbox.fileInfo(destination, "root", signal);
      if (info.type === FileType.FILE && !info.symlinkTarget && info.size === bytes.length) {
        const existing = Buffer.from(await sandbox.readFile(
          destination,
          "root",
          signal,
          this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
        ));
        if (sha256Hex(existing) === contentSha256) return destination;
      }
    } catch {
      // Missing or invalid snapshots are replaced atomically below.
    }

    const stagingPath = path.posix.join(E2B_CONTROL_TMP, `source-${randomUUID()}`);
    await sandbox.writeFile(
      stagingPath,
      bytes,
      "root",
      signal,
      this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
    );
    try {
      await runControl(
        sandbox,
        [
          `chown root ${quoteShellToken(stagingPath)}`,
          `chmod 444 ${quoteShellToken(stagingPath)}`,
          `mv -f ${quoteShellToken(stagingPath)} ${quoteShellToken(destination)}`,
        ].join(" && "),
        this.input.config.E2B_REQUEST_TIMEOUT_MS,
        signal,
      );
    } finally {
      await sandbox.removeFile(stagingPath, "root").catch(() => undefined);
    }
    return destination;
  }

  private rememberConnection(
    state: RuntimeState,
    sandbox: E2BSandbox,
    continuousStartedAt?: number,
  ): void {
    if (state.sandboxId !== sandbox.id) {
      state.toolboxValidatedSandboxId = undefined;
      state.websiteSandboxId = undefined;
      state.websiteIdleUntil = undefined;
      state.websitePublishedPending = false;
      state.threadFilesSync = undefined;
    }
    state.connection = sandbox;
    state.sandboxId = sandbox.id;
    if (continuousStartedAt !== undefined) state.continuousStartedAt = continuousStartedAt;
  }

  private idleTimeout(
    state: RuntimeState,
    sandboxId: string | undefined,
    startPendingWindow: boolean,
  ): { timeoutMs: number; website: boolean; startPendingWindow?: boolean } {
    const matches = sandboxId !== undefined && state.websiteSandboxId === sandboxId;
    if (!matches) {
      state.websiteSandboxId = undefined;
      state.websiteIdleUntil = undefined;
      state.websitePublishedPending = false;
      return { timeoutMs: E2B_IDLE_PAUSE_MS, website: false };
    }
    const now = Date.now();
    if (state.websitePublishedPending) {
      return {
        timeoutMs: E2B_WEBSITE_IDLE_PAUSE_MS,
        website: true,
        ...(startPendingWindow ? { startPendingWindow: true } : {}),
      };
    }
    const remainingMs = state.websiteIdleUntil === undefined
      ? 0
      : Math.max(0, state.websiteIdleUntil - now);
    if (remainingMs > 0) {
      return { timeoutMs: Math.max(E2B_IDLE_PAUSE_MS, remainingMs), website: true };
    }
    state.websiteSandboxId = undefined;
    state.websiteIdleUntil = undefined;
    return { timeoutMs: E2B_IDLE_PAUSE_MS, website: false };
  }

  private commitIdleTimeout(
    state: RuntimeState,
    sandboxId: string | undefined,
    idle: { startPendingWindow?: boolean },
  ): void {
    if (
      !idle.startPendingWindow
      || sandboxId === undefined
      || state.websiteSandboxId !== sandboxId
      || !state.websitePublishedPending
    ) return;
    state.websiteIdleUntil = Date.now() + E2B_WEBSITE_IDLE_PAUSE_MS;
    state.websitePublishedPending = false;
  }

  private scheduleRenewal(scope: SandboxScope, state: RuntimeState): void {
    if (state.renewTimer || state.leases === 0 || this.shuttingDown) return;
    state.renewTimer = setTimeout(() => {
      state.renewTimer = undefined;
      if (state.leases === 0 || this.shuttingDown) return;
      void this.enqueue(scope, undefined, async () => {
        if (!state.connection) return;
        const requestedRenewalMs = Math.max(
          E2B_IDLE_PAUSE_MS,
          this.idleTimeout(state, state.connection.id, false).timeoutMs,
        );
        let sandbox = await this.rotateIfNeeded(
          state,
          scope,
          state.connection,
          requestedRenewalMs,
        );
        const renewalWindowMs = Math.max(
          E2B_IDLE_PAUSE_MS,
          this.idleTimeout(state, sandbox.id, false).timeoutMs,
        );
        await sandbox.setTimeout(renewalWindowMs);
        this.rememberConnection(state, sandbox);
      }).catch((error) => {
        this.input.logger?.warn("E2B activity renewal failed", {
          ...scope,
          sandboxId: state.sandboxId,
          error: String(error),
        });
      }).finally(() => this.scheduleRenewal(scope, state));
    }, RENEW_INTERVAL_MS);
    state.renewTimer.unref?.();
  }

  private clearRenewal(state: RuntimeState): void {
    if (state.renewTimer) clearTimeout(state.renewTimer);
    state.renewTimer = undefined;
  }

  private stateFor(scope: SandboxScope): RuntimeState {
    const key = scopeKey(scope);
    let state = this.states.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), leases: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private enqueue<T>(
    scope: SandboxScope,
    signal: AbortSignal | undefined,
    operation: (state: RuntimeState) => Promise<T>,
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("E2B runtime is shutting down"));
    const state = this.stateFor(scope);
    const result = state.tail.then(async () => {
      throwIfAborted(signal);
      return operation(state);
    });
    state.tail = result.then(() => undefined, () => undefined);
    return raceWithAbort(result, signal);
  }
}

function sandboxMetadata(config: AppConfig, scope: SandboxScope): Record<string, string> {
  return {
    app: "ai-tg-bot",
    deployment: config.E2B_DEPLOYMENT_ID,
    template_ref: config.E2B_TEMPLATE,
    telegram_user_id: String(scope.userId),
    thread_id: String(scope.threadId),
  };
}

function scopeKey(scope: SandboxScope): string {
  return `${scope.userId}:${scope.threadId}`;
}

async function inspectFileSourceInventory(
  sandbox: E2BSandbox,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FileSourceInventoryEntry[]> {
  const script = [
    "import json,os,re,stat,sys",
    "source_root=sys.argv[1]",
    "out=[]",
    "try:",
    " entries=list(os.scandir(source_root))",
    "except Exception:",
    " entries=[]",
    "for entry in entries:",
    " if not re.fullmatch(r'[0-9a-fA-F]{64}',entry.name): continue",
    " try:",
    "  info=entry.stat(follow_symlinks=False)",
    "  if not stat.S_ISREG(info.st_mode): continue",
    "  out.append({'name':entry.name,'size':info.st_size,'mtime_ms':info.st_mtime_ns//1000000})",
    " except Exception:",
    "  pass",
    "print(json.dumps(out,separators=(',',':')))",
  ].join("\n");
  const result = await runCommandResult(
    sandbox,
    shellJoin(["python3", "-c", script, E2B_FILE_SOURCES]),
    timeoutMs,
    signal,
    "root",
  );
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value): FileSourceInventoryEntry[] => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string" || !/^[0-9a-f]{64}$/i.test(record.name)) return [];
    if (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) return [];
    const modifiedAtMs = typeof record.mtime_ms === "number"
      && Number.isSafeInteger(record.mtime_ms)
      && record.mtime_ms >= 0
      ? record.mtime_ms
      : 0;
    return [{
      canonicalPath: path.posix.join(E2B_FILE_SOURCES, record.name),
      size: record.size,
      modifiedAtMs,
    }];
  });
}

function removeFileSourceSnapshot(
  sandbox: E2BSandbox,
  canonicalPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return runControl(
    sandbox,
    `rm -f -- ${quoteShellToken(canonicalPath)}`,
    timeoutMs,
    signal,
  );
}

function isSandboxMissing(error: unknown): boolean {
  return error instanceof SandboxNotFoundError;
}
