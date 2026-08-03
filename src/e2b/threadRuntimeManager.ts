import { randomUUID } from "node:crypto";
import path from "node:path";
import { SandboxNotFoundError, TimeoutError } from "e2b";
import { autoRetry } from "@grammyjs/auto-retry";
import { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import { throwIfAborted } from "../files/cancel.js";
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
  SandboxSourceFileReadRequest,
  SandboxThreadFile,
  SandboxThreadFileSyncResult,
} from "../sandbox/types.js";
import { quoteShellToken, shellJoin } from "../util/shell.js";
import { buildBoundedCommandCapture, commandOutputReadLimit } from "./commandCapture.js";
import {
  createE2BClient,
  E2B_IDLE_PAUSE_MS,
  E2B_WEBSITE_IDLE_PAUSE_MINUTES,
  E2B_WEBSITE_IDLE_PAUSE_MS,
  FileType,
  type E2BClient,
  type E2BSandbox,
} from "./client.js";
import {
  E2B_CONTROL_TMP,
  E2B_FILE_SOURCES,
  E2B_RUNTIME_TMP,
  E2B_TELEGRAM_FILES,
  E2B_WORKSPACE,
  isSameOrDescendant,
  sandboxWebsiteDirectory,
  sandboxWorkspaceFile,
} from "./paths.js";
import { MAX_FILE_BYTES } from "../files/limits.js";

type SandboxScope = { userId: number; threadId: number };
type RuntimeState = {
  tail: Promise<void>;
  leases: number;
  websiteSandboxId?: string;
  websiteIdleUntil?: number;
  websitePublishedPending?: boolean;
  threadFilesSync?: {
    sandboxId: string;
    revision: string;
    result: SandboxThreadFileSyncResult;
    retryAt?: number;
    failureAttempts?: number;
  };
  connection?: E2BSandbox;
  sandboxId?: string;
  continuousStartedAt?: number;
  renewTimer?: NodeJS.Timeout;
};

type ThreadFileIndexEntry = {
  file_id: number;
  message_id: number | null;
  original_name: string;
  sandbox_name: string;
  mime_type: string | null;
  descriptor_size?: number | null;
  descriptor_sha256?: string | null;
  size: number | null;
  sha256: string | null;
  status: "available" | "error";
  error_code?: string;
  error_detail?: string;
};

type ThreadFileIndex = {
  version: 2;
  generated_at: string;
  files: ThreadFileIndexEntry[];
};

type TelegramRestoreResult = {
  file_id: number;
  status: "available" | "error";
  ref_id: number | null;
  size?: number;
  sha256?: string;
  error_code?: string;
  error_detail?: string;
};

type ThreadFileInventoryEntry = {
  sandbox_name: string;
  regular: boolean;
  size: number | null;
  sha256: string | null;
};

const RENEW_INTERVAL_MS = 60_000;
const CONTINUOUS_ROTATE_MS = 55 * 60_000;
const ROTATION_GUARD_MS = 5 * 60_000;
const MAX_FOREGROUND_COMMAND_MS = 45 * 60_000;
const WEBSITE_MIN_PORT = 1024;
const WEBSITE_MAX_PORT = 65_535;
const RESERVED_PORTS = new Set([49_983, 49_999, 50_005]);
const FILE_RESTORE_RETRY_BASE_MS = 5 * 60_000;
const FILE_RESTORE_RETRY_MAX_MS = 60 * 60_000;

export class ThreadE2BSandboxRuntimeManager implements CommandRuntime {
  private readonly states = new Map<string, RuntimeState>();
  private readonly client: E2BClient;
  private readonly downloadTelegramBytes: (fileId: string, signal?: AbortSignal) => Promise<Buffer>;
  private shuttingDown = false;

  constructor(private readonly input: {
    config: AppConfig;
    repos: Repos;
    logger?: Logger;
    client?: E2BClient;
    downloadTelegramBytes?: (fileId: string, signal?: AbortSignal) => Promise<Buffer>;
  }) {
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
      return this.executeLocked(prepared.sandbox, request, timeoutMs, prepared.threadFiles);
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
    validateWebsitePort(request.port);
    const sitePath = normalizeWebsitePath(request.path);
    const siteDirectory = sandboxWebsiteDirectory(request.siteDirectory);
    const scope = { userId: request.userId, threadId: request.threadId };
    return this.enqueue(scope, request.signal, async (state) => {
      const prepared = await this.prepareSandbox(
        state,
        scope,
        request.threadFiles ?? [],
        ROTATION_GUARD_MS,
        request.signal,
      );
      const canonicalSiteDirectory = await verifyWebsiteListenerScope(
        prepared.sandbox,
        request.port,
        siteDirectory,
        this.input.config.E2B_REQUEST_TIMEOUT_MS,
        request.signal,
      );
      const url = websiteUrlForHost(prepared.sandbox.getHost(request.port), sitePath);
      await verifyWebsite(url, this.input.config.E2B_REQUEST_TIMEOUT_MS, request.signal);
      state.websiteSandboxId = prepared.sandbox.id;
      state.websitePublishedPending = true;
      this.input.logger?.info("E2B website published", {
        ...scope,
        sandboxId: prepared.sandbox.id,
        port: request.port,
        siteDirectory: canonicalSiteDirectory,
        url,
      });
      return {
        sandboxId: prepared.sandbox.id,
        port: request.port,
        siteDirectory: canonicalSiteDirectory,
        path: sitePath,
        url,
        pausesAfterMinutes: E2B_WEBSITE_IDLE_PAUSE_MINUTES,
      };
    });
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    for (const state of this.states.values()) this.clearRenewal(state);
    await Promise.allSettled([...this.states.values()].map((state) => state.tail));
    this.states.clear();
  }

  private async prepareSandbox(
    state: RuntimeState,
    scope: SandboxScope,
    files: SandboxThreadFile[],
    requestedDurationMs: number,
    signal?: AbortSignal,
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
    await this.ensureLayout(sandbox, signal);
    const threadFiles = await this.syncThreadFiles(state, scope, sandbox, files, signal);
    return { sandbox, threadFiles };
  }

  private async acquireConnection(
    state: RuntimeState,
    scope: SandboxScope,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<E2BSandbox> {
    if (state.connection && await state.connection.isRunning(signal).catch(() => false)) {
      await state.connection.setTimeout(timeoutMs, signal);
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
          await this.removeRedundantSandbox(scope, info.sandboxId, winner.sandbox_id);
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
    await sandbox.setTimeout(timeoutMs, signal);
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

  private async syncThreadFiles(
    state: RuntimeState,
    scope: SandboxScope,
    sandbox: E2BSandbox,
    files: SandboxThreadFile[],
    signal?: AbortSignal,
  ): Promise<SandboxThreadFileSyncResult> {
    const revision = threadFilesRevision(files);
    const previousSync = state.threadFilesSync;
    if (previousSync?.sandboxId === sandbox.id && previousSync.revision === revision) {
      if (previousSync.retryAt === undefined || Date.now() < previousSync.retryAt) {
        return previousSync.result;
      }
    }
    state.threadFilesSync = undefined;
    const failureAttempts = previousSync?.sandboxId === sandbox.id && previousSync.revision === revision
      ? previousSync.failureAttempts ?? 0
      : 0;
    const indexPath = path.posix.join(E2B_TELEGRAM_FILES, "INDEX.json");
    const previous = await readThreadFileIndex(sandbox, indexPath, signal);
    const previousById = new Map(previous.files.map((entry) => [entry.file_id, entry]));
    const inventory = await inspectThreadFileIndex(sandbox, indexPath, this.input.config.E2B_REQUEST_TIMEOUT_MS, signal);
    const inventoryByName = new Map(inventory.map((entry) => [entry.sandbox_name, entry]));
    const next: ThreadFileIndexEntry[] = [];
    const desiredNames = new Set<string>();
    const pending: Array<{
      file: SandboxThreadFile;
      sandboxName: string;
    }> = [];

    // ensureLayout keeps this directory root-owned. Mode 0755 lets the agent read
    // and traverse it but grants write permission only to root during reconciliation.
    await runControl(
      sandbox,
      `chmod 755 ${quoteShellToken(E2B_TELEGRAM_FILES)}`,
      this.input.config.E2B_REQUEST_TIMEOUT_MS,
      signal,
    );
    let syncFailed = false;
    let syncFailure: unknown;
    try {
      for (const file of files) {
        throwIfAborted(signal);
        const sandboxName = sandboxThreadFileName(file.fileId, file.name);
        desiredNames.add(sandboxName);
        const old = previousById.get(file.fileId);
        const existingInfo = old?.status === "available"
          ? inventoryByName.get(sandboxName)
          : undefined;
        const expectedUnchanged = old?.status === "available"
          && old.sandbox_name === sandboxName
          && old.descriptor_size === file.expectedSize
          && old.descriptor_sha256 === file.expectedSha256
          && existingInfo?.regular === true
          && (old.size === null || existingInfo.size === old.size)
          && old.sha256 !== null
          && existingInfo.sha256 === old.sha256;
        if (expectedUnchanged) {
          next.push(old);
          await this.recordRestoreStatus({
            threadId: scope.threadId,
            sandbox,
            file,
            sandboxName,
            status: "available",
            restoredSize: old.size,
            restoredSha256: old.sha256,
            attemptedAt: Date.now(),
            completedAt: Date.now(),
          });
          continue;
        }
        pending.push({ file, sandboxName });
      }

      const restored = await this.restoreTelegramFiles(sandbox, pending, signal);
      const restoredById = new Map(restored.map((entry) => [entry.file_id, entry]));
      for (const item of pending) {
        const attemptedAt = Date.now();
        const result = restoredById.get(item.file.fileId) ?? {
          file_id: item.file.fileId,
          status: "error" as const,
          ref_id: null,
          error_code: "restore_process_failed",
          error_detail: "the sandbox restore process returned no result",
        };
        if (result.status === "available") {
          next.push({
            file_id: item.file.fileId,
            message_id: item.file.messageId,
            original_name: item.file.name,
            sandbox_name: item.sandboxName,
            mime_type: item.file.mimeType,
            descriptor_size: item.file.expectedSize,
            descriptor_sha256: item.file.expectedSha256,
            size: result.size ?? null,
            sha256: result.sha256 ?? null,
            status: "available",
          });
          await this.recordRestoreStatus({
            threadId: scope.threadId,
            sandbox,
            file: item.file,
            sandboxName: item.sandboxName,
            telegramFileRefId: result.ref_id,
            status: "available",
            restoredSize: result.size ?? null,
            restoredSha256: result.sha256 ?? null,
            attemptedAt,
            completedAt: Date.now(),
          });
        } else {
          const errorCode = sanitizeRestoreCode(result.error_code);
          const errorDetail = sanitizeRestoreDetail(result.error_detail);
          await runControl(
            sandbox,
            `rm -f ${quoteShellToken(path.posix.join(E2B_TELEGRAM_FILES, item.sandboxName))}`,
            this.input.config.E2B_REQUEST_TIMEOUT_MS,
            signal,
          );
          next.push({
            file_id: item.file.fileId,
            message_id: item.file.messageId,
            original_name: item.file.name,
            sandbox_name: item.sandboxName,
            mime_type: item.file.mimeType,
            descriptor_size: item.file.expectedSize,
            descriptor_sha256: item.file.expectedSha256,
            size: null,
            sha256: null,
            status: "error",
            error_code: errorCode,
            error_detail: errorDetail,
          });
          await this.recordRestoreStatus({
            threadId: scope.threadId,
            sandbox,
            file: item.file,
            sandboxName: item.sandboxName,
            telegramFileRefId: result.ref_id,
            status: "error",
            errorCode,
            errorDetail,
            attemptedAt,
          });
          this.input.logger?.warn("E2B Telegram file restore failed", {
            sandboxId: sandbox.id,
            fileId: item.file.fileId,
            errorCode,
            errorDetail,
          });
        }
      }

      for (const old of previous.files) {
        if (old.sandbox_name === "INDEX.json" || desiredNames.has(old.sandbox_name)) continue;
        await sandbox.removeFile(path.posix.join(E2B_TELEGRAM_FILES, old.sandbox_name), "root", signal)
          .catch(() => undefined);
      }
      const index: ThreadFileIndex = {
        version: 2,
        generated_at: new Date().toISOString(),
        files: next,
      };
      const stagingIndex = path.posix.join(E2B_CONTROL_TMP, `index-${randomUUID()}.json`);
      await sandbox.writeFile(stagingIndex, `${JSON.stringify(index, null, 2)}\n`, "root", signal);
      await runControl(
        sandbox,
        [
          `chown root ${quoteShellToken(stagingIndex)}`,
          `chmod 444 ${quoteShellToken(stagingIndex)}`,
          `mv -f ${quoteShellToken(stagingIndex)} ${quoteShellToken(indexPath)}`,
        ].join(" && "),
        this.input.config.E2B_REQUEST_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      syncFailed = true;
      syncFailure = error;
      throw error;
    } finally {
      try {
        await runControl(
          sandbox,
          `chown -R root ${quoteShellToken(E2B_TELEGRAM_FILES)} && find ${quoteShellToken(E2B_TELEGRAM_FILES)} -type f -exec chmod 444 {} + && chmod 555 ${quoteShellToken(E2B_TELEGRAM_FILES)}`,
          this.input.config.E2B_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        this.input.logger?.warn("failed to seal E2B Telegram files directory", {
          sandboxId: sandbox.id,
          syncFailed,
          error: String(error),
        });
        if (syncFailed) {
          throw new AggregateError(
            [syncFailure, error],
            `Telegram file synchronization failed (${String(syncFailure)}); sealing also failed (${String(error)})`,
          );
        }
        throw error;
      }
    }
    const result = {
      directory: E2B_TELEGRAM_FILES,
      available: next.filter((entry) => entry.status === "available").length,
    };
    const hasFailures = next.some((entry) => entry.status === "error");
    const nextFailureAttempts = hasFailures ? failureAttempts + 1 : 0;
    state.threadFilesSync = {
      sandboxId: sandbox.id,
      revision,
      result,
      ...(hasFailures
        ? {
            failureAttempts: nextFailureAttempts,
            retryAt: Date.now() + restoreRetryDelayMs(nextFailureAttempts),
          }
        : {}),
    };
    return result;
  }

  private async restoreTelegramFiles(
    sandbox: E2BSandbox,
    pending: Array<{ file: SandboxThreadFile; sandboxName: string }>,
    signal?: AbortSignal,
  ): Promise<TelegramRestoreResult[]> {
    if (!pending.length) return [];
    const results = new Array<TelegramRestoreResult>(pending.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const item = pending[index];
        if (!item) return;
        results[index] = await this.restoreTelegramFile(sandbox, item, signal);
      }
    };
    const settlements = await Promise.allSettled(
      Array.from(
        { length: Math.min(pending.length, this.input.config.TELEGRAM_FILE_RESTORE_CONCURRENCY) },
        () => worker(),
      ),
    );
    const rejected = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    return results;
  }

  private async restoreTelegramFile(
    sandbox: E2BSandbox,
    item: { file: SandboxThreadFile; sandboxName: string },
    signal?: AbortSignal,
  ): Promise<TelegramRestoreResult> {
    const local = await this.restoreLocalFileSource(sandbox, item, signal);
    if (local) return local;
    const candidates = primaryTelegramRestoreCandidates(item.file);
    let lastRefId: number | null = null;
    let lastError: unknown = candidates.length ? undefined : new Error("no primary Telegram file reference");
    for (const candidate of candidates) {
      throwIfAborted(signal);
      lastRefId = candidate.id;
      try {
        const timeoutSignal = AbortSignal.timeout(this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS);
        const transferSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const bytes = await this.downloadTelegramBytes(candidate.telegramFileId, transferSignal);
        if (bytes.length > MAX_FILE_BYTES) throw new Error("file exceeds the configured size limit");
        if (candidate.telegramSize !== null && bytes.length !== candidate.telegramSize) {
          throw new Error("Telegram file size did not match the recorded representation");
        }
        const sha256 = sha256Hex(bytes);
        const exactRepresentation = candidate.telegramSize !== null
          && item.file.expectedSize !== null
          && candidate.telegramSize === item.file.expectedSize;
        // Telegram may re-encode outbound photos. When the recorded Telegram size differs
        // from the original, accept that primary representation as best-effort recovery;
        // INDEX.json and restore diagnostics retain the bytes' actual size and hash.
        if (exactRepresentation && item.file.expectedSha256 && sha256 !== item.file.expectedSha256) {
          throw new Error("Telegram file hash did not match the recorded representation");
        }
        const stagingPath = path.posix.join(E2B_CONTROL_TMP, `restore-${randomUUID()}`);
        const destination = path.posix.join(E2B_TELEGRAM_FILES, item.sandboxName);
        await sandbox.writeFile(stagingPath, bytes, "root", transferSignal);
        try {
          await runControl(
            sandbox,
            [
              `chown root ${quoteShellToken(stagingPath)}`,
              `chmod 444 ${quoteShellToken(stagingPath)}`,
              `mv -f ${quoteShellToken(stagingPath)} ${quoteShellToken(destination)}`,
            ].join(" && "),
            this.input.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
            transferSignal,
          );
        } finally {
          await sandbox.removeFile(stagingPath, "root").catch(() => undefined);
        }
        return {
          file_id: item.file.fileId,
          status: "available",
          ref_id: candidate.id,
          size: bytes.length,
          sha256,
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
      }
    }
    return {
      file_id: item.file.fileId,
      status: "error",
      ref_id: lastRefId,
      error_code: candidates.length ? "file_unavailable" : "missing_telegram_reference",
      error_detail: sanitizeRestoreDetail(lastError),
    };
  }

  private async restoreLocalFileSource(
    sandbox: E2BSandbox,
    item: { file: SandboxThreadFile; sandboxName: string },
    signal?: AbortSignal,
  ): Promise<TelegramRestoreResult | undefined> {
    if (!item.file.expectedSha256) return undefined;
    if (!item.file.telegramRefs.some((ref) => ref.isPrimary && ref.direction === "outbound")) {
      return undefined;
    }
    const source = path.posix.join(E2B_FILE_SOURCES, item.file.expectedSha256);
    try {
      const inspected = await inspectSandboxFile(
        sandbox,
        source,
        this.input.config.E2B_REQUEST_TIMEOUT_MS,
        signal,
      );
      if (
        inspected.sha256 !== item.file.expectedSha256
        || (item.file.expectedSize !== null && inspected.size !== item.file.expectedSize)
      ) {
        return undefined;
      }
      const stagingPath = path.posix.join(E2B_TELEGRAM_FILES, `.restore-${randomUUID()}`);
      const destination = path.posix.join(E2B_TELEGRAM_FILES, item.sandboxName);
      try {
        await runControl(
          sandbox,
          [
            `cp -- ${quoteShellToken(source)} ${quoteShellToken(stagingPath)}`,
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
      return {
        file_id: item.file.fileId,
        status: "available",
        ref_id: null,
        size: inspected.size,
        sha256: inspected.sha256,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return undefined;
    }
  }

  private async recordRestoreStatus(input: {
    threadId: number;
    sandbox: E2BSandbox;
    file: SandboxThreadFile;
    sandboxName: string;
    telegramFileRefId?: number | null;
    status: "available" | "error";
    restoredSize?: number | null;
    restoredSha256?: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
    attemptedAt: number;
    completedAt?: number | null;
  }): Promise<void> {
    await this.input.repos.sandboxFileRestores.upsert({
      deploymentId: this.input.config.E2B_DEPLOYMENT_ID,
      threadId: input.threadId,
      sandboxId: input.sandbox.id,
      fileId: input.file.fileId,
      telegramFileRefId: input.telegramFileRefId,
      sandboxName: input.sandboxName,
      status: input.status,
      restoredSize: input.restoredSize,
      restoredSha256: input.restoredSha256,
      errorCode: input.errorCode,
      errorDetail: input.errorDetail,
      attemptedAt: input.attemptedAt,
      completedAt: input.completedAt,
    }).catch((error) => {
      this.input.logger?.warn("failed to persist E2B Telegram restore status", {
        sandboxId: input.sandbox.id,
        fileId: input.file.fileId,
        error: String(error),
      });
    });
  }

  private async executeLocked(
    sandbox: E2BSandbox,
    request: SandboxCommandRequest,
    timeoutMs: number,
    threadFiles: SandboxThreadFileSyncResult,
  ): Promise<SandboxCommandResult> {
    throwIfAborted(request.signal);
    const runRoot = path.posix.join(E2B_RUNTIME_TMP, randomUUID());
    const stdinPath = path.posix.join(runRoot, "stdin");
    const stdoutPath = path.posix.join(runRoot, "stdout");
    const stderrPath = path.posix.join(runRoot, "stderr");
    await runControl(
      sandbox,
      `umask 077 && mkdir -p ${quoteShellToken(runRoot)} && chown user ${quoteShellToken(runRoot)} && chmod 700 ${quoteShellToken(runRoot)}`,
      this.input.config.E2B_REQUEST_TIMEOUT_MS,
      request.signal,
    );
    await sandbox.writeFile(stdinPath, request.stdin, "user", request.signal);
    const command = buildBoundedCommandCapture({
      command: request.command,
      args: request.args,
      stdinPath,
      stdoutPath,
      stderrPath,
      maxOutputChars: request.maxOutputChars,
    });
    let exitCode: number | null = null;
    let timedOut = false;
    let errorText: string | undefined;
    try {
      const handle = await sandbox.runBackground(command, {
        cwd: request.workingDir,
        envs: {
          ...request.env,
          AGENT_WORKSPACE: E2B_WORKSPACE,
          TELEGRAM_FILES_DIR: E2B_TELEGRAM_FILES,
        },
        user: "user",
        timeoutMs,
        signal: request.signal,
      });
      try {
        const result = await waitForCommand(handle, request.signal);
        exitCode = result.exitCode;
        if (result.error) errorText = result.error;
      } catch (error) {
        if (request.signal?.aborted) {
          await handle.kill().catch(() => undefined);
          throw request.signal.reason ?? error;
        }
        const commandError = commandErrorResult(error);
        exitCode = commandError.exitCode;
        timedOut = commandError.timedOut;
        errorText = commandError.error;
      }
      const stdoutBytes = await readIfExists(sandbox, stdoutPath, request.signal);
      const stderrBytes = await readIfExists(sandbox, stderrPath, request.signal);
      const stdout = truncateUtf8(stdoutBytes, request.maxOutputChars);
      const stderr = truncateUtf8(stderrBytes, request.maxOutputChars);
      const readLimit = commandOutputReadLimit(request.maxOutputChars);
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        timedOut,
        stdoutTruncated: stdout.truncated || stdoutBytes.length >= readLimit,
        stderrTruncated: stderr.truncated || stderrBytes.length >= readLimit,
        threadFiles,
        ...(errorText ? { error: errorText } : {}),
      };
    } finally {
      await runControl(
        sandbox,
        `rm -rf -- ${quoteShellToken(runRoot)}`,
        this.input.config.E2B_REQUEST_TIMEOUT_MS,
      ).catch((error) => {
        this.input.logger?.warn("failed to clean E2B command files", {
          sandboxId: sandbox.id,
          runRoot,
          error: String(error),
        });
      });
    }
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
    const bytes = Buffer.from(await sandbox.readFile(canonicalPath, realpathUser, signal));
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
        const existing = Buffer.from(await sandbox.readFile(destination, "root", signal));
        if (sha256Hex(existing) === contentSha256) return destination;
      }
    } catch {
      // Missing or invalid snapshots are replaced atomically below.
    }

    const stagingPath = path.posix.join(E2B_CONTROL_TMP, `source-${randomUUID()}`);
    await sandbox.writeFile(stagingPath, bytes, "root", signal);
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
    return abortable(result, signal);
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

function threadFilesRevision(files: SandboxThreadFile[]): string {
  const normalized = files.map((file) => ({
    fileId: file.fileId,
    messageId: file.messageId,
    sandboxName: `${file.fileId}--${sanitizeFileName(file.name)}`,
    expectedSize: file.expectedSize,
    expectedSha256: file.expectedSha256,
    telegramRefs: file.telegramRefs
      .filter((ref) => ref.isPrimary)
      .map((ref) => ({
        id: ref.id,
        telegramFileId: ref.telegramFileId,
        telegramSize: ref.telegramSize,
        width: ref.width ?? null,
        height: ref.height ?? null,
        direction: ref.direction,
        mediaKind: ref.mediaKind,
      }))
      .sort((left, right) => left.id - right.id),
  }));
  return sha256Hex(Buffer.from(JSON.stringify(normalized)));
}

function primaryTelegramRestoreCandidates(
  file: SandboxThreadFile,
): SandboxThreadFile["telegramRefs"] {
  const newestFirst = (refs: SandboxThreadFile["telegramRefs"]) =>
    refs.sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.id - left.id);
  const primary = file.telegramRefs.filter((ref) => ref.isPrimary);
  if (primary.length < 2) return newestFirst(primary);

  // Prefer representations known to be byte-sized like the canonical file. This
  // prevents a later, smaller photo alias from displacing the original variant.
  if (file.expectedSize !== null) {
    const exactSize = primary.filter((ref) => ref.telegramSize === file.expectedSize);
    if (exactSize.length) return newestFirst(exactSize);
  }

  // A document representation is preferable to Telegram's photo transcoding.
  const documents = primary.filter((ref) => ref.mediaKind === "document");
  if (documents.length) return newestFirst(documents);

  const pixelAreas = primary.map((ref) =>
    ref.width !== null && ref.width !== undefined && ref.height !== null && ref.height !== undefined
      ? ref.width * ref.height
      : null);
  const knownAreas = pixelAreas.filter((area): area is number => area !== null);
  if (knownAreas.length === primary.length) {
    const largestArea = Math.max(...knownAreas);
    return newestFirst(primary.filter((_ref, index) => pixelAreas[index] === largestArea));
  }

  const knownSizes = primary
    .map((ref) => ref.telegramSize)
    .filter((size): size is number => size !== null);
  if (knownSizes.length === primary.length) {
    const largestSize = Math.max(...knownSizes);
    return newestFirst(primary.filter((ref) => ref.telegramSize === largestSize));
  }
  return newestFirst(primary);
}

async function inspectThreadFileIndex(
  sandbox: E2BSandbox,
  indexPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ThreadFileInventoryEntry[]> {
  const script = [
    "import hashlib,json,os,stat,sys",
    "index_path=sys.argv[1]",
    "root=os.path.dirname(index_path)",
    "out=[]",
    "try:",
    " data=json.load(open(index_path,encoding='utf-8'))",
    "except Exception:",
    " data={'files':[]}",
    "for entry in data.get('files',[]):",
    " name=entry.get('sandbox_name')",
    " item={'sandbox_name':name if isinstance(name,str) else '', 'regular':False, 'size':None, 'sha256':None}",
    " if not isinstance(name,str) or os.path.basename(name)!=name or name in ('.','..'):",
    "  out.append(item); continue",
    " candidate=os.path.join(root,name)",
    " try:",
    "  info=os.lstat(candidate)",
    "  if not stat.S_ISREG(info.st_mode):",
    "   out.append(item); continue",
    "  digest=hashlib.sha256()",
    "  with open(candidate,'rb') as handle:",
    "   for chunk in iter(lambda:handle.read(1024*1024),b''): digest.update(chunk)",
    "  item.update(regular=True,size=info.st_size,sha256=digest.hexdigest())",
    " except Exception:",
    "  pass",
    " out.append(item)",
    "print(json.dumps(out,separators=(',',':')))",
  ].join("\n");
  const result = await runCommandResult(
    sandbox,
    shellJoin(["python3", "-c", script, indexPath]),
    timeoutMs,
    signal,
    "root",
  );
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value): ThreadFileInventoryEntry[] => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (typeof record.sandbox_name !== "string") return [];
    return [{
      sandbox_name: record.sandbox_name,
      regular: record.regular === true,
      size: typeof record.size === "number" ? record.size : null,
      sha256: typeof record.sha256 === "string" ? record.sha256 : null,
    }];
  });
}

async function inspectSandboxFile(
  sandbox: E2BSandbox,
  filePath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const script = [
    "import hashlib,json,os,stat,sys",
    "path=sys.argv[1]",
    "info=os.lstat(path)",
    "assert stat.S_ISREG(info.st_mode)",
    "digest=hashlib.sha256()",
    "with open(path,'rb') as handle:",
    " for chunk in iter(lambda:handle.read(1024*1024),b''): digest.update(chunk)",
    "print(json.dumps({'size':info.st_size,'sha256':digest.hexdigest()},separators=(',',':')))",
  ].join("\n");
  const result = await runCommandResult(
    sandbox,
    shellJoin(["python3", "-c", script, filePath]),
    timeoutMs,
    signal,
    "root",
  );
  const parsed = JSON.parse(result.stdout) as { size?: unknown; sha256?: unknown };
  if (typeof parsed.size !== "number" || typeof parsed.sha256 !== "string") {
    throw new Error("sandbox file inspection returned invalid metadata");
  }
  return { size: parsed.size, sha256: parsed.sha256 };
}

async function readThreadFileIndex(
  sandbox: E2BSandbox,
  path: string,
  signal?: AbortSignal,
): Promise<ThreadFileIndex> {
  if (!await sandbox.fileExists(path, "user", signal).catch(() => false)) {
    return { version: 2, generated_at: new Date(0).toISOString(), files: [] };
  }
  try {
    const parsed = JSON.parse(await sandbox.readText(path, "user", signal)) as {
      version?: number;
      generated_at?: string;
      files?: Array<ThreadFileIndexEntry & { error?: string }>;
    };
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.files)) {
      throw new Error("unsupported index");
    }
    return {
      version: 2,
      generated_at: typeof parsed.generated_at === "string"
        ? parsed.generated_at
        : new Date(0).toISOString(),
      files: parsed.files.map((entry) => ({
        file_id: entry.file_id,
        message_id: entry.message_id,
        original_name: entry.original_name,
        sandbox_name: entry.sandbox_name,
        mime_type: entry.mime_type,
        descriptor_size: entry.descriptor_size,
        descriptor_sha256: entry.descriptor_sha256,
        size: entry.size,
        sha256: entry.sha256,
        status: entry.status,
        ...(entry.status === "error"
          ? {
            error_code: entry.error_code ?? "legacy_restore_error",
            error_detail: entry.error_detail ?? entry.error ?? "legacy file restoration failed",
          }
          : {}),
      })),
    };
  } catch {
    return { version: 2, generated_at: new Date(0).toISOString(), files: [] };
  }
}

function sanitizeFileName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120)
    .replace(/[._-]+$/g, "");
  return normalized || "file";
}

function sandboxThreadFileName(fileId: number, originalName: string): string {
  if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error("invalid Telegram file id");
  const sandboxName = `${fileId}--${sanitizeFileName(originalName)}`;
  const candidate = path.posix.resolve(E2B_TELEGRAM_FILES, sandboxName);
  if (path.posix.dirname(candidate) !== E2B_TELEGRAM_FILES) {
    throw new Error("unsafe Telegram file sandbox path");
  }
  return sandboxName;
}

function sanitizeRestoreCode(value: unknown): string {
  const normalized = typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80)
    : "";
  return normalized || "download_failed";
}

function sanitizeRestoreDetail(value: unknown): string {
  const normalized = String(value ?? "file restoration failed")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return (normalized || "file restoration failed").slice(0, 500);
}

async function runControl(
  sandbox: E2BSandbox,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await runCommandResult(sandbox, command, timeoutMs, signal, "root");
}

async function runCommandResult(
  sandbox: E2BSandbox,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  user = "root",
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await sandbox.run(command, { timeoutMs, signal, user });
    return result;
  } catch (error) {
    const result = commandErrorResult(error);
    throw new Error(result.error || `sandbox command failed with exit code ${String(result.exitCode)}`);
  }
}

async function readIfExists(sandbox: E2BSandbox, filePath: string, signal?: AbortSignal): Promise<Buffer> {
  if (!await sandbox.fileExists(filePath, "user", signal).catch(() => false)) return Buffer.alloc(0);
  return Buffer.from(await sandbox.readFile(filePath, "user", signal));
}

async function waitForCommand(
  handle: { wait(): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }> },
  signal?: AbortSignal,
) {
  if (!signal) return handle.wait();
  throwIfAborted(signal);
  return new Promise<Awaited<ReturnType<typeof handle.wait>>>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    handle.wait().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function commandErrorResult(error: unknown): { exitCode: number | null; timedOut: boolean; error: string } {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  const message = String(record.error ?? record.message ?? error);
  return {
    exitCode,
    timedOut: error instanceof TimeoutError,
    error: message,
  };
}

function truncateUtf8(bytes: Buffer, maxChars: number): { text: string; truncated: boolean } {
  const text = bytes.toString("utf8");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function isSandboxMissing(error: unknown): boolean {
  return error instanceof SandboxNotFoundError;
}

function validateWebsitePort(port: number): void {
  if (!Number.isInteger(port) || port < WEBSITE_MIN_PORT || port > WEBSITE_MAX_PORT || RESERVED_PORTS.has(port)) {
    throw new Error(`website port must be an unreserved integer from ${WEBSITE_MIN_PORT} to ${WEBSITE_MAX_PORT}`);
  }
}

function normalizeWebsitePath(value: string | undefined): string {
  const raw = value?.trim() || "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) throw new Error("website path must start with one slash");
  const url = new URL(raw, "https://example.invalid");
  if (url.origin !== "https://example.invalid") throw new Error("website path must be relative to the published host");
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    throw new Error("website path must remain relative after normalization");
  }
  return normalized;
}

function websiteUrlForHost(host: string, sitePath: string): string {
  const source = new URL(sitePath, "https://example.invalid");
  const target = new URL(`https://${host}`);
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = source.hash;
  return target.toString();
}

function restoreRetryDelayMs(failureAttempts: number): number {
  const exponent = Math.max(0, Math.min(10, failureAttempts - 1));
  return Math.min(FILE_RESTORE_RETRY_MAX_MS, FILE_RESTORE_RETRY_BASE_MS * (2 ** exponent));
}

async function verifyWebsiteListenerScope(
  sandbox: E2BSandbox,
  port: number,
  siteDirectory: string,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const script = [
    "import os,re,subprocess,sys",
    "server_site=os.path.realpath(sys.argv[1])",
    "workspace=os.path.realpath(sys.argv[2])",
    "port=int(sys.argv[3])",
    "if server_site==workspace or os.path.commonpath([server_site,workspace])!=workspace:",
    " raise SystemExit('website directory must be a dedicated workspace subdirectory')",
    "if not os.path.isdir(server_site):",
    " raise SystemExit('website directory does not exist')",
    "probe=subprocess.run(['ss','-H','-ltnp',f'sport = :{port}'],capture_output=True,text=True,check=False)",
    "pids=sorted(set(re.findall(r'pid=(\\d+)',probe.stdout)))",
    "if not pids:",
    " raise SystemExit('website port has no identifiable listening process')",
    "allowed=False",
    "for pid in pids:",
    " try:",
    "  cwd=os.path.realpath(f'/proc/{pid}/cwd')",
    "  if cwd==server_site or os.path.commonpath([cwd,server_site])==server_site:",
    "   allowed=True; break",
    " except (FileNotFoundError,PermissionError,ValueError):",
    "  pass",
    "if not allowed:",
    " raise SystemExit('website listener is not running from the declared site directory')",
    "print(server_site)",
  ].join("\n");
  const result = await runCommandResult(
    sandbox,
    shellJoin(["python3", "-c", script, siteDirectory, E2B_WORKSPACE, String(port)]),
    requestTimeoutMs,
    signal,
    "root",
  );
  const canonical = result.stdout.trim();
  if (canonical === E2B_WORKSPACE || !isSameOrDescendant(canonical, E2B_WORKSPACE)) {
    throw new Error("website listener validation returned an unsafe site directory");
  }
  return canonical;
}

async function verifyWebsite(url: string, requestTimeoutMs: number, signal?: AbortSignal): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + Math.max(5_000, requestTimeoutMs);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const timeoutSignal = AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now())));
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(url, { signal: combined, redirect: "manual" });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`website did not become reachable at ${url}: ${String(lastError)}`);
}
