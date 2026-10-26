import { afterEach } from "vitest";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import type { CreatedFileAttachment } from "../../src/files/types.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const files: OutgoingFiles[] = [];
const directories: string[] = [];
afterEach(async () => {
  try { await Promise.all(files.splice(0).map((owner) => owner.dispose())); }
  finally { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); }
});

export function testOutgoingFiles(input: ConstructorParameters<typeof OutgoingFiles>[0], items: unknown[] = []): OutgoingFiles {
  if (!input.fileResolver && input.config.FILE_STORAGE_PATH === "./data/files") {
    const directory = mkdtempSync(path.join(tmpdir(), "outgoing-fixture-"));
    directories.push(directory);
    input = { ...input, config: { ...input.config, FILE_STORAGE_PATH: directory } };
  }
  const owner = new OutgoingFiles(input, items as CreatedFileAttachment[]);
  files.push(owner);
  return owner;
}
