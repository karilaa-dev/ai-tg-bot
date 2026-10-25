import { z } from "zod";
import type { FileRow } from "../db/types.js";
import { assertLocalIntegrity, localFileKey, type LocalFileIntegrity, type LocalFileStore } from "./localStore.js";
import type { ChatFileSource, ChatFileSourceAdapter } from "./source.js";

const localLocator = z.object({ size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });

export function localFileSource(file: Pick<FileRow, "id" | "mime_type">, integrity: LocalFileIntegrity): ChatFileSource {
  return {
    transport: "local",
    connectionKey: "default",
    remoteKey: localFileKey(String(file.id)),
    locator: { size: integrity.size, sha256: integrity.contentSha256 },
    mimeType: file.mime_type,
  };
}

export class LocalFileSourceAdapter implements ChatFileSourceAdapter {
  readonly transport = "local";
  readonly connectionKey = "default";

  constructor(private readonly store: LocalFileStore) {}

  async fetch(source: ChatFileSource, signal?: AbortSignal, maxBytes?: number): Promise<Buffer> {
    const locator = localLocator.parse(source.locator);
    const bytes = await this.store.read(source.remoteKey, signal, maxBytes);
    assertLocalIntegrity(bytes, { size: locator.size, contentSha256: locator.sha256 });
    return bytes;
  }
}
