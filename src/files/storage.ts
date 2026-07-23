import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { FilesRepo } from "../db/repos/files.js";
import { MAX_FILE_BYTES } from "./limits.js";

export const FILES_DIR = "data/files";
export const CHAT_FILES_DIR = ".chat-files";

type ManagedFileConfig = Pick<AppConfig, "BASH_WORKSPACE_ROOT"> & Partial<Pick<AppConfig, "MANAGED_FILE_ROOT">>;

export class ManagedFileStore {
  readonly root: string;
  private readonly legacyRoots: string[];

  constructor(config: ManagedFileConfig) {
    this.root = config.MANAGED_FILE_ROOT
      ? path.resolve(config.MANAGED_FILE_ROOT)
      : path.resolve(config.BASH_WORKSPACE_ROOT, CHAT_FILES_DIR);
    this.legacyRoots = [
      path.resolve(config.BASH_WORKSPACE_ROOT, CHAT_FILES_DIR),
      path.resolve(FILES_DIR),
    ];
  }

  pathFor(fileId: number): string {
    assertFileId(fileId);
    return path.join(this.root, String(fileId), "content");
  }

  write(fileId: number, input: Buffer | Uint8Array): Promise<string> {
    return this.writeBytes(fileId, input, "overwrite");
  }

  writeNew(fileId: number, input: Buffer | Uint8Array): Promise<string> {
    return this.writeBytes(fileId, input, "no-clobber");
  }

  async readManaged(fileId: number): Promise<{ path: string; bytes: Buffer } | undefined> {
    const filePath = this.pathFor(fileId);
    const bytes = await readSafeRegularFile(filePath, MAX_FILE_BYTES);
    if (!bytes) return undefined;
    await fs.chmod(filePath, 0o600);
    return { path: filePath, bytes };
  }

  async readKnownPath(fileId: number, filePath: string): Promise<{ path: string; bytes: Buffer; managed: boolean } | undefined> {
    const resolved = path.resolve(filePath);
    const managedPath = this.pathFor(fileId);
    const managed = resolved === managedPath;
    if (!managed && !this.legacyRoots.some((root) => isPathInside(root, resolved))) return undefined;
    const bytes = await readSafeRegularFile(resolved, MAX_FILE_BYTES);
    if (!bytes) return undefined;
    if (managed) await fs.chmod(resolved, 0o600);
    return { path: resolved, bytes, managed };
  }

  async remove(fileId: number): Promise<void> {
    assertFileId(fileId);
    await fs.rm(path.dirname(this.pathFor(fileId)), { recursive: true, force: true });
  }

  private async writeBytes(
    fileId: number,
    input: Buffer | Uint8Array,
    mode: "overwrite" | "no-clobber",
  ): Promise<string> {
    assertFileId(fileId);
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`File #${fileId} exceeds the file size limit.`);
    await ensurePrivateDirectory(this.root);
    const directory = path.join(this.root, String(fileId));
    await ensurePrivateDirectory(directory);
    const finalPath = this.pathFor(fileId);
    const partialPath = path.join(directory, `.content.part-${process.pid}-${randomUUID()}`);
    let failure: unknown;
    try {
      await fs.writeFile(partialPath, bytes, { flag: "wx", mode: 0o600 });
      if (mode === "no-clobber") await assertPathAbsent(finalPath);
      await fs.rename(partialPath, finalPath);
      await fs.chmod(finalPath, 0o600);
      return finalPath;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await cleanupPartialFile(partialPath, failure);
    }
  }
}

export async function persistManagedFile(
  config: ManagedFileConfig,
  files: FilesRepo,
  fileId: number,
  bytes: Buffer | Uint8Array,
): Promise<string> {
  const filePath = await new ManagedFileStore(config).write(fileId, bytes);
  await files.setPath(fileId, filePath);
  return filePath;
}

export async function clearManagedFiles(root = path.resolve(FILES_DIR)): Promise<number> {
  const outDir = path.resolve(root);
  const count = await countFiles(outDir);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  return count;
}

async function assertPathAbsent(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  const error = new Error(`Managed file already exists: ${filePath}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  throw error;
}

async function cleanupPartialFile(filePath: string, primaryError?: unknown): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    if (primaryError !== undefined) {
      throw new AggregateError([primaryError, error], `Managed file operation and cleanup both failed: ${filePath}`);
    }
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const existing = await fs.lstat(directory).catch(() => undefined);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Managed file store path is not a safe directory: ${directory}`);
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function readSafeRegularFile(filePath: string, maxBytes: number): Promise<Buffer | undefined> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
  const bytes = await fs.readFile(filePath).catch(() => undefined);
  if (!bytes || bytes.length > maxBytes) return undefined;
  return bytes;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertFileId(fileId: number): void {
  if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error(`Invalid chat file id: ${fileId}`);
}

async function countFiles(root: string): Promise<number> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(path.join(root, entry.name));
    else count += 1;
  }
  return count;
}
