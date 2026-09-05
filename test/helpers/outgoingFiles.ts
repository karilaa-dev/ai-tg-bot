import { afterEach } from "vitest";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import type { CreatedFileAttachment } from "../../src/files/types.js";

const files: OutgoingFiles[] = [];
afterEach(async () => { await Promise.all(files.splice(0).map((owner) => owner.dispose())); });

export function testOutgoingFiles(input: ConstructorParameters<typeof OutgoingFiles>[0], items: unknown[] = []): OutgoingFiles {
  const owner = new OutgoingFiles(input, items as CreatedFileAttachment[]);
  files.push(owner);
  return owner;
}
