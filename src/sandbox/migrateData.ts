import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { FileRow, ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { ManagedFileStore } from "../files/storage.js";
import { botThreadWorkspace } from "./paths.js";

export interface SandboxDataMigrationResult {
  dryRun: boolean;
  workspaces: number;
  workspaceFilesCopied: number;
  managedFilesCopied: number;
  managedPathsUpdated: number;
  identicalFiles: number;
  conflicts: number;
  unsafeEntries: number;
}

type CopySummary = {
  copied: number;
  identical: number;
  conflicts: number;
  unsafe: number;
};

type PromotionMarker = {
  version: number;
  userId: number;
  threadId: number;
};

export async function migrateSandboxData(input: {
  config: AppConfig;
  db: AppDatabase;
  apply: boolean;
  logger?: Logger;
}): Promise<SandboxDataMigrationResult> {
  const result: SandboxDataMigrationResult = {
    dryRun: !input.apply,
    workspaces: 0,
    workspaceFilesCopied: 0,
    managedFilesCopied: 0,
    managedPathsUpdated: 0,
    identicalFiles: 0,
    conflicts: 0,
    unsafeEntries: 0,
  };
  const threads = await input.db.db.query<Pick<ThreadRow, "id" | "user_id">>(sql`select id, user_id from threads`);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const legacyRoot = path.resolve(input.config.BASH_WORKSPACE_ROOT);
  const legacyEntries = await readOptionalDirectory(legacyRoot);
  for (const entry of legacyEntries) {
    const match = /^thread-(\d+)$/.exec(entry.name);
    if (!match) continue;
    const thread = threadsById.get(Number(match[1]));
    if (!thread) continue;
    result.workspaces += 1;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      result.unsafeEntries += 1;
      continue;
    }
    const source = path.join(legacyRoot, entry.name);
    const target = botThreadWorkspace(input.config, thread.user_id, thread.id);
    const copied = await copyTreeWithoutLinks(source, target, input.apply);
    result.workspaceFilesCopied += copied.copied;
    result.identicalFiles += copied.identical;
    result.conflicts += copied.conflicts;
    result.unsafeEntries += copied.unsafe;
    if (input.apply && copied.conflicts === 0 && copied.unsafe === 0) {
      await writePromotionMarker(input.config, thread.user_id, thread.id);
    }
  }

  const store = new ManagedFileStore(input.config);
  const files = await input.db.db.query<Pick<FileRow, "id" | "path">>(sql`select id, path from files`);
  for (const file of files) {
    const legacyPath = file.path ?? path.join(legacyRoot, ".chat-files", String(file.id), "content");
    const targetPath = store.pathFor(file.id);
    if (path.resolve(legacyPath) === targetPath) continue;
    const sourceStat = await optionalLstat(legacyPath);
    if (!sourceStat) {
      if (file.path) result.conflicts += 1;
      continue;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > MAX_FILE_BYTES) {
      result.unsafeEntries += 1;
      continue;
    }
    const known = await store.readKnownPath(file.id, legacyPath);
    if (!known) {
      result.conflicts += 1;
      continue;
    }
    const targetStat = await optionalLstat(targetPath);
    let existing: Awaited<ReturnType<ManagedFileStore["readManaged"]>> = undefined;
    if (targetStat) {
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size > MAX_FILE_BYTES) {
        result.unsafeEntries += 1;
        continue;
      }
      existing = await store.readManaged(file.id);
      if (!existing) {
        result.conflicts += 1;
        continue;
      }
    }
    if (existing && !existing.bytes.equals(known.bytes)) {
      result.conflicts += 1;
      continue;
    }
    if (existing) result.identicalFiles += 1;
    else result.managedFilesCopied += 1;
    if (input.apply) {
      if (!existing) await store.writeNew(file.id, known.bytes);
      await input.db.db.execute(sql`update files set path = ${targetPath} where id = ${file.id}`);
    }
    result.managedPathsUpdated += 1;
  }

  input.logger?.info("sandbox data migration complete", result);
  return result;
}

const promotedWorkspaces = new Set<string>();
const workspacePromotions = new Map<string, Promise<void>>();

export function promoteLegacyThreadWorkspace(
  config: AppConfig,
  userId: number,
  threadId: number,
): Promise<void> {
  const key = `${path.resolve(config.BASH_WORKSPACE_ROOT)}:${path.resolve(config.AGENT_SHARED_ROOT)}:${userId}:${threadId}`;
  if (promotedWorkspaces.has(key)) return Promise.resolve();
  const existing = workspacePromotions.get(key);
  if (existing) return existing;
  const promotion = promoteLegacyThreadWorkspaceNow(config, userId, threadId).then(() => {
    promotedWorkspaces.add(key);
  }).finally(() => {
    workspacePromotions.delete(key);
  });
  workspacePromotions.set(key, promotion);
  return promotion;
}

async function promoteLegacyThreadWorkspaceNow(
  config: AppConfig,
  userId: number,
  threadId: number,
): Promise<void> {
  const marker = promotionMarkerPath(config, userId, threadId);
  const markerStat = await optionalLstat(marker);
  if (markerStat) {
    await validatePromotionMarker(marker, { version: BOX_LAYOUT_VERSION, userId, threadId });
    return;
  }
  const source = path.resolve(config.BASH_WORKSPACE_ROOT, `thread-${threadId}`);
  const sourceStat = await optionalLstat(source);
  if (!sourceStat) return;
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`legacy workspace is not a safe directory: ${source}`);
  }
  const target = botThreadWorkspace(config, userId, threadId);
  const copied = await copyTreeWithoutLinks(source, target, true);
  if (copied.conflicts || copied.unsafe) {
    throw new Error(`legacy workspace promotion found ${copied.conflicts} conflicts and ${copied.unsafe} unsafe entries`);
  }
  await writePromotionMarker(config, userId, threadId);
}

async function copyTreeWithoutLinks(
  source: string,
  target: string,
  apply: boolean,
): Promise<CopySummary> {
  const result = emptyCopySummary();
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink()) return { ...result, unsafe: 1 };
  if (!sourceStat.isDirectory()) return { ...result, conflicts: 1 };
  const targetStat = await optionalLstat(target);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) return { ...result, conflicts: 1 };
  if (apply) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      result.unsafe += 1;
      continue;
    }
    if (entry.isDirectory()) {
      merge(result, await copyTreeWithoutLinks(sourcePath, targetPath, apply));
      continue;
    }
    if (!entry.isFile()) {
      result.unsafe += 1;
      continue;
    }
    const targetEntry = await optionalLstat(targetPath);
    if (targetEntry) {
      if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
        result.conflicts += 1;
      } else if (await filesEqual(sourcePath, targetPath)) {
        result.identical += 1;
      } else {
        result.conflicts += 1;
      }
      continue;
    }
    result.copied += 1;
    if (apply) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      await copyNewFileAtomically(sourcePath, targetPath);
    }
  }
  return result;
}

async function copyNewFileAtomically(source: string, target: string): Promise<void> {
  const partial = path.join(
    path.dirname(target),
    `.${path.basename(target)}.sandbox-part-${process.pid}-${randomUUID()}`,
  );
  let failure: unknown;
  try {
    const sourceStat = await fs.stat(source);
    await fs.copyFile(source, partial, fs.constants.COPYFILE_EXCL);
    await fs.chmod(partial, sourceStat.mode & 0o777);
    if (await optionalLstat(target)) {
      const error = new Error(`migration target already exists: ${target}`) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    await fs.rename(partial, target);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await fs.unlink(partial);
    } catch (error) {
      if (!isNotFound(error)) {
        if (failure !== undefined) {
          throw new AggregateError([failure, error], `migration copy and cleanup both failed: ${target}`);
        }
        throw error;
      }
    }
  }
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (leftStat.size !== rightStat.size) return false;
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash === rightHash;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readOptionalDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new Error(`cannot read legacy workspace root ${directory}: ${String(error)}`);
  }
}

async function optionalLstat(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function promotionMarkerPath(config: Pick<AppConfig, "AGENT_SHARED_ROOT">, userId: number, threadId: number): string {
  return path.join(path.resolve(config.AGENT_SHARED_ROOT), ".migrations", "workspaces", String(userId), `${threadId}.json`);
}

async function writePromotionMarker(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
): Promise<void> {
  const marker = promotionMarkerPath(config, userId, threadId);
  const expected: PromotionMarker = { version: BOX_LAYOUT_VERSION, userId, threadId };
  await fs.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(marker, JSON.stringify(expected), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await validatePromotionMarker(marker, expected);
  }
}

async function validatePromotionMarker(marker: string, expected: PromotionMarker): Promise<void> {
  const stat = await fs.lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
    throw new Error(`workspace migration marker is unsafe: ${marker}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(marker, "utf8"));
  } catch (error) {
    throw new Error(`workspace migration marker is invalid: ${marker}: ${String(error)}`);
  }
  if (!matchesPromotionMarker(parsed, expected)) {
    throw new Error(`workspace migration marker does not match this workspace: ${marker}`);
  }
}

function matchesPromotionMarker(value: unknown, expected: PromotionMarker): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return marker.version === expected.version
    && marker.userId === expected.userId
    && marker.threadId === expected.threadId;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

const BOX_LAYOUT_VERSION = 1;

function emptyCopySummary(): CopySummary {
  return { copied: 0, identical: 0, conflicts: 0, unsafe: 0 };
}

function merge(target: CopySummary, source: CopySummary): void {
  target.copied += source.copied;
  target.identical += source.identical;
  target.conflicts += source.conflicts;
  target.unsafe += source.unsafe;
}
