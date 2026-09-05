import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../files/hash.js";

export const OFFICE_BUNDLE_PATH = "/usr/local/share/ai-tg-bot/office";
let pending:
  | Promise<{ revision: string; files: Array<{ path: string; bytes: Buffer }> }>
  | undefined;
export function officeBundle() {
  return (pending ??= load());
}
async function load() {
  const root = fileURLToPath(
    new URL("../../e2b-template/assets/office/", import.meta.url),
  );
  const files: Array<{ path: string; bytes: Buffer }> = [];
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(location);
      else if (entry.isFile())
        files.push({
          path: `${OFFICE_BUNDLE_PATH}/${path.relative(root, location).split(path.sep).join("/")}`,
          bytes: await fs.readFile(location),
        });
    }
  }
  await visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    revision: sha256Hex(
      Buffer.from(
        files
          .map((file) => `${sha256Hex(file.bytes)}  ${file.path}\n`)
          .join(""),
      ),
    ),
  };
}
