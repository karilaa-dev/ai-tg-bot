import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

export const FILES_DIR = "data/files";

export async function clearManagedFiles(root = path.resolve(FILES_DIR)): Promise<number> {
  const outDir = path.resolve(root);
  const count = await countFiles(outDir);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  return count;
}

export async function storeFileBytes(bytes: Buffer | Uint8Array, ext: string): Promise<string> {
  const outDir = path.resolve(FILES_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, `${nanoid()}${ext}`);
  try {
    await fs.writeFile(dest, bytes);
  } catch (err) {
    await fs.unlink(dest).catch(() => undefined);
    throw err;
  }
  return dest;
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
