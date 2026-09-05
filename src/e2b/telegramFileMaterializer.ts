import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import { throwIfAborted } from "../files/cancel.js";
import { sha256Hex } from "../files/hash.js";
import type { Logger } from "../logger.js";
import type { SandboxThreadFile, SandboxThreadFileSyncResult } from "../sandbox/types.js";
import { quoteShellToken, shellJoin } from "../util/shell.js";
import { type E2BSandbox } from "./client.js";
import { E2B_CONTROL_TMP, E2B_FILE_SOURCES, E2B_TELEGRAM_FILES } from "./paths.js";
import { MAX_FILE_BYTES } from "../files/limits.js";

import { runControl, runCommandResult } from "./sandboxCommandExecutor.js";
export type ThreadFileSync = {
  sandboxId: string; revision: string; result: SandboxThreadFileSyncResult; retryAt?: number; failureAttempts?: number;
};
type MaterializerInput = {
  config: AppConfig; repos: Repos; logger?: Logger;
  downloadTelegramBytes(fileId: string, signal?: AbortSignal): Promise<Buffer>;
};
const FILE_RESTORE_RETRY_BASE_MS = 5 * 60_000;
const FILE_RESTORE_RETRY_MAX_MS = 60 * 60_000;

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

export async function syncThreadFiles(context: MaterializerInput,
  state: { threadFilesSync?: ThreadFileSync },
  scope: { userId: number; threadId: number },
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
  const inventory = await inspectThreadFileIndex(sandbox, indexPath, context.config.E2B_REQUEST_TIMEOUT_MS, signal);
  const inventoryByName = new Map(inventory.map((entry) => [entry.sandbox_name, entry]));
  const nextById = new Map(previous.files.map((entry) => [entry.file_id, entry]));
  const pending: Array<{
    file: SandboxThreadFile;
    sandboxName: string;
  }> = [];

  // ensureLayout keeps this directory root-owned. Mode 0755 lets the agent read
  // and traverse it but grants write permission only to root during reconciliation.
  await runControl(
    sandbox,
    `chmod 755 ${quoteShellToken(E2B_TELEGRAM_FILES)}`,
    context.config.E2B_REQUEST_TIMEOUT_MS,
    signal,
  );
  let syncFailed = false;
  let syncFailure: unknown;
  try {
    for (const file of files) {
      throwIfAborted(signal);
      const sandboxName = sandboxThreadFileName(file.fileId, file.name);
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
        nextById.set(file.fileId, old);
        await recordRestoreStatus(context, {
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

    const restored = await restoreTelegramFiles(context, sandbox, pending, signal);
    const restoredById = new Map(restored.map((entry) => [entry.file_id, entry]));
    for (const item of pending) {
      const old = previousById.get(item.file.fileId);
      const attemptedAt = Date.now();
      const result = restoredById.get(item.file.fileId) ?? {
        file_id: item.file.fileId,
        status: "error" as const,
        ref_id: null,
        error_code: "restore_process_failed",
        error_detail: "the sandbox restore process returned no result",
      };
      if (result.status === "available") {
        if (old?.sandbox_name !== item.sandboxName && old && isSandboxThreadFileName(old.sandbox_name)) {
          await sandbox.removeFile(path.posix.join(E2B_TELEGRAM_FILES, old.sandbox_name), "root", signal)
            .catch(() => undefined);
        }
        nextById.set(item.file.fileId, {
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
        await recordRestoreStatus(context, {
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
        const errorDetail = sanitizeRestoreDetail(result.error_detail, context.config.BOT_TOKEN);
        await runControl(
          sandbox,
          `rm -f ${quoteShellToken(path.posix.join(E2B_TELEGRAM_FILES, item.sandboxName))}`,
          context.config.E2B_REQUEST_TIMEOUT_MS,
          signal,
        );
        nextById.set(item.file.fileId, {
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
        await recordRestoreStatus(context, {
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
        context.logger?.warn("E2B Telegram file restore failed", {
          sandboxId: sandbox.id,
          fileId: item.file.fileId,
          errorCode,
          errorDetail,
        });
      }
    }

    const next = [...nextById.values()]
      .filter((entry) => isSandboxThreadFileName(entry.sandbox_name))
      .sort((left, right) => left.file_id - right.file_id);
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
      context.config.E2B_REQUEST_TIMEOUT_MS,
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
        context.config.E2B_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      context.logger?.warn("failed to seal E2B Telegram files directory", {
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
  const next = [...nextById.values()]
    .filter((entry) => isSandboxThreadFileName(entry.sandbox_name))
    .sort((left, right) => left.file_id - right.file_id);
  const result: SandboxThreadFileSyncResult = {
    directory: E2B_TELEGRAM_FILES,
    available: next.filter((entry) => entry.status === "available").length,
    files: next.map(materializedFileFromIndex),
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

async function restoreTelegramFiles(context: MaterializerInput,
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
      results[index] = await restoreTelegramFile(context, sandbox, item, signal);
    }
  };
  const settlements = await Promise.allSettled(
    Array.from(
      { length: Math.min(pending.length, context.config.TELEGRAM_FILE_RESTORE_CONCURRENCY) },
      () => worker(),
    ),
  );
  const rejected = settlements.find(
    (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return results;
}

async function restoreTelegramFile(context: MaterializerInput,
  sandbox: E2BSandbox,
  item: { file: SandboxThreadFile; sandboxName: string },
  signal?: AbortSignal,
): Promise<TelegramRestoreResult> {
  const local = await restoreLocalFileSource(context, sandbox, item, signal);
  if (local) return local;
  const candidates = primaryTelegramRestoreCandidates(item.file);
  let lastRefId: number | null = null;
  let lastError: unknown = candidates.length ? undefined : new Error("no primary Telegram file reference");
  for (const candidate of candidates) {
    throwIfAborted(signal);
    lastRefId = candidate.id;
    try {
      const timeoutSignal = AbortSignal.timeout(context.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS);
      const transferSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const bytes = await context.downloadTelegramBytes(candidate.telegramFileId, transferSignal);
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
      await sandbox.writeFile(
        stagingPath,
        bytes,
        "root",
        transferSignal,
        context.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
      );
      try {
        await runControl(
          sandbox,
          [
            `chown root ${quoteShellToken(stagingPath)}`,
            `chmod 444 ${quoteShellToken(stagingPath)}`,
            `mv -f ${quoteShellToken(stagingPath)} ${quoteShellToken(destination)}`,
          ].join(" && "),
          context.config.TELEGRAM_FILE_RESTORE_TIMEOUT_MS,
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
    error_detail: sanitizeRestoreDetail(lastError, context.config.BOT_TOKEN),
  };
}

async function restoreLocalFileSource(context: MaterializerInput,
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
      context.config.E2B_REQUEST_TIMEOUT_MS,
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
        context.config.E2B_REQUEST_TIMEOUT_MS,
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

async function recordRestoreStatus(context: MaterializerInput, input: {
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
  await context.repos.sandboxFileRestores.upsert({
    deploymentId: context.config.E2B_DEPLOYMENT_ID,
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
    context.logger?.warn("failed to persist E2B Telegram restore status", {
      sandboxId: input.sandbox.id,
      fileId: input.file.fileId,
      error: String(error),
    });
  });
}

export function threadFilesRevision(files: SandboxThreadFile[]): string {
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

function materializedFileFromIndex(entry: ThreadFileIndexEntry) {
  return {
    fileId: entry.file_id,
    originalName: entry.original_name,
    mimeType: entry.mime_type,
    path: entry.status === "available"
      ? path.posix.join(E2B_TELEGRAM_FILES, entry.sandbox_name)
      : null,
    status: entry.status === "available"
      ? "available" as const
      : entry.error_code === "missing_telegram_reference"
        ? "source_unavailable" as const
        : "restore_failed" as const,
    ...(entry.error_code ? { errorCode: entry.error_code } : {}),
  };
}

export function requestedFileSyncResult(
  result: SandboxThreadFileSyncResult,
  files: SandboxThreadFile[],
): SandboxThreadFileSyncResult {
  const requested = new Set(files.map((file) => file.fileId));
  const selected = result.files.filter((file) => requested.has(file.fileId));
  return {
    directory: result.directory,
    available: selected.filter((file) => file.status === "available").length,
    files: selected,
  };
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

function isSandboxThreadFileName(value: string): boolean {
  if (path.posix.basename(value) !== value) return false;
  const match = /^([1-9]\d*)--([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/.exec(value);
  if (!match) return false;
  const fileId = Number(match[1]);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) return false;
  const candidate = path.posix.resolve(E2B_TELEGRAM_FILES, value);
  return path.posix.dirname(candidate) === E2B_TELEGRAM_FILES;
}

function sanitizeRestoreCode(value: unknown): string {
  const normalized = typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80)
    : "";
  return normalized || "download_failed";
}

function sanitizeRestoreDetail(value: unknown, botToken?: string): string {
  let detail = String(value ?? "file restoration failed");
  const token = botToken?.trim();
  if (token) {
    const encoded = encodeURIComponent(token);
    const variants = new Set([token, encoded, encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase())]);
    for (const variant of variants) detail = detail.replaceAll(variant, "[redacted]");
  }
  const normalized = detail
    .replace(/https?:\/\/api\.telegram\.org\/file\/bot[^/\s"']+/gi, "https://api.telegram.org/file/bot[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return (normalized || "file restoration failed").slice(0, 500);
}

function restoreRetryDelayMs(failureAttempts: number): number {
  const exponent = Math.max(0, Math.min(10, failureAttempts - 1));
  return Math.min(FILE_RESTORE_RETRY_MAX_MS, FILE_RESTORE_RETRY_BASE_MS * (2 ** exponent));
}
