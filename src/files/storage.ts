import fs from "node:fs/promises";
import path from "node:path";
import type { FilesRepo } from "../db/repos/files.js";

export const FILES_DIR = "data/files";

export async function clearManagedFiles(root = path.resolve(FILES_DIR)): Promise<number> {
  const outDir = path.resolve(root);
  const count = await countFiles(outDir);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  return count;
}

export async function clearRemoteBackedManagedFiles(
  files: FilesRepo,
  root = path.resolve(FILES_DIR),
): Promise<number> {
  const managedRoot = path.resolve(root);
  const rows = await files.remoteBackedFilesWithPaths();
  let removed = 0;
  for (const row of rows) {
    if (!row.path) continue;
    const filePath = path.resolve(row.path);
    const relative = path.relative(managedRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await files.clearPath(row.id);
    removed += 1;
  }
  return removed;
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
