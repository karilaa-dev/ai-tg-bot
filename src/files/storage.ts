import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

export const FILES_DIR = "data/files";

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
