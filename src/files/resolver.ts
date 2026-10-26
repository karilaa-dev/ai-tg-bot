import { sha256Hex } from "./hash.js";
import { z } from "zod";
import { LocalFileConflictError, type LocalFileIntegrity, type LocalFileStore } from "./localStore.js";
import { localFileSource, LocalFileSourceAdapter } from "./localSource.js";

import type { FileRow, FileSourceRow } from "../db/types.js";
import type { FilesRepo } from "../db/repos/files.js";
import { isAbortError, throwIfAborted } from "./cancel.js";
import { FileTooLargeError, MAX_FILE_BYTES, TG_DOWNLOAD_MAX_BYTES } from "./limits.js";
import {
  type FileReadPolicy,
  SandboxConsentRequired,
  type ChatFileSource,
  type ChatFileSourceAdapter,
  type ResolvedChatFile,
} from "./source.js";

class FileSourceRegistry {
  private readonly adapters = new Map<string, ChatFileSourceAdapter>();

  register(adapter: ChatFileSourceAdapter): void {
    this.adapters.set(adapterKey(adapter.transport, adapter.connectionKey), adapter);
  }

  get(source: Pick<ChatFileSource, "transport" | "connectionKey">): ChatFileSourceAdapter | undefined {
    return this.adapters.get(adapterKey(source.transport, source.connectionKey));
  }
}

export class FileResolver {
  constructor(
    private readonly files: FilesRepo,
    readonly registry = new FileSourceRegistry(),
    private readonly localStore?: LocalFileStore,
  ) {
    if (localStore) registry.register(new LocalFileSourceAdapter(localStore));
  }

  async persistFile(file: FileRow, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.localStore) throw new Error("Local file storage is not configured.");
    if (!file.content_sha256) file = await this.files.get(file.id) ?? file;
    const integrity = { size: bytes.byteLength, contentSha256: sha256Hex(bytes) };
    if (hasUnknownTelegramSize(file)
      && (await this.files.listSources(file.id)).some(source => source.transport === "telegram" || source.transport === "local")) {
      // Publish without repair first: concurrent first downloads must agree.
      await this.cacheFile(file, bytes, integrity, signal);
      await this.files.updateExtraction(file.id, {
        contentSha256: integrity.contentSha256, size: integrity.size,
        mimeType: file.mime_type, contentMd: file.content_md,
        summary: file.summary, outline: file.outline_json === null ? null : JSON.parse(file.outline_json),
        isInline: Boolean(file.is_inline), status: file.extraction_status,
      });
      return;
    }
    assertCanonicalIntegrity(file, integrity, "ingested");
    await this.cacheFile(file, bytes, integrity, signal);
    if (!file.content_sha256) await this.files.updateContentHash(file.id, integrity.contentSha256);
  }

  private async cacheFile(file: FileRow, bytes: Uint8Array, integrity: LocalFileIntegrity, signal?: AbortSignal): Promise<void> {
    if (this.localStore) {
      try {
        await this.localStore.write(String(file.id), bytes, signal);
      } catch (error) {
        if (!(error instanceof LocalFileConflictError) || !file.content_sha256) throw error;
        await this.localStore.repair(String(file.id), bytes, integrity, signal);
      }
      await this.files.rememberSource(file.id, localFileSource(file, integrity));
    }
  }

  async removeLocalFile(fileId: FileRow["id"]): Promise<void> {
    await this.localStore?.remove(String(fileId));
  }

  async resolveFile(file: FileRow, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES, policy?: FileReadPolicy): Promise<ResolvedChatFile> {
    throwIfAborted(signal);
    // Callers may retain pre-backfill rows. Once established, the hash is canonical.
    if (!file.content_sha256) file = await this.files.get(file.id) ?? file;
    if (file.size > maxBytes) throw new FileTooLargeError();
    const sources = await this.files.listSources(file.id);
    sources.sort((a, b) => Number(b.transport === "local") - Number(a.transport === "local")
      || Number(b.transport === "web") - Number(a.transport === "web")
      || (policy ? Number(a.transport === "e2b") - Number(b.transport === "e2b") : 0));
    const errors: string[] = [];
    let consentRequired = false;
    for (const source of sources) {
      if (policy?.excludeSandbox && source.transport === "e2b") continue;
      try {
        const resolved = await this.resolveSource(rowToSource(source), signal, maxBytes, policy);
        if (source.transport === "local" && source.remote_key !== String(file.id)) throw new Error("Local source UUID does not match its file.");
        if (hasUnknownTelegramSize(file)
          && (source.transport === "telegram" || source.transport === "local")) {
          if (this.localStore) await this.persistFile(file, resolved.bytes, signal);
        } else {
          assertCanonicalIntegrity(file, resolved, source.transport);
          if (this.localStore && source.transport !== "local") await this.persistFile(file, resolved.bytes, signal);
        }
        await this.files.markSourceVerified(source.id).catch(() => undefined);
        return resolved;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        if (error instanceof SandboxConsentRequired) consentRequired = true;
        errors.push(`${source.transport}/${source.connection_key}: ${String(error)}`);
      }
    }
    if (consentRequired) throw new SandboxConsentRequired();
    throw new Error(errors.length
      ? `No source for file #${file.id} could be loaded (${errors.join("; ")}).`
      : `File #${file.id} has no durable source.`);
  }

  async resolveSource(source: ChatFileSource, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES, policy?: FileReadPolicy): Promise<ResolvedChatFile> {
    const adapter = this.registry.get(source);
    if (!adapter) throw new Error(`No ${source.transport}/${source.connectionKey} file adapter is configured.`);
    throwIfAborted(signal);
    const limit = Math.min(maxBytes, source.transport === "telegram" ? TG_DOWNLOAD_MAX_BYTES : MAX_FILE_BYTES);
    const payload = await adapter.fetch(source, signal, limit, policy);
    throwIfAborted(signal);
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (bytes.length > limit) throw new FileTooLargeError();
    return {
      bytes,
      mimeType: source.mimeType ?? null,
      size: bytes.length,
      contentSha256: sha256Hex(bytes),
      source,
    };
  }
}

function hasUnknownTelegramSize(file: FileRow): boolean {
  // Older Telegram registrations used zero when Telegram omitted file_size.
  return file.extraction_status === "source_only" && file.size === 0 && !file.content_sha256;
}

function assertCanonicalIntegrity(file: FileRow, resolved: { size: number; contentSha256: string }, transport: string): void {
  if (resolved.size !== file.size) {
    throw new Error(`${transport} source size mismatch for file #${file.id}.`);
  }
  if (file.content_sha256 && resolved.contentSha256 !== file.content_sha256) {
    throw new Error(`${transport} source hash mismatch for file #${file.id}.`);
  }
}

function rowToSource(row: FileSourceRow): ChatFileSource {
  const locator = z.record(z.string(), z.unknown()).parse(JSON.parse(row.locator_json));
  return {
    transport: row.transport,
    connectionKey: row.connection_key,
    remoteKey: row.remote_key,
    locator,
    mimeType: row.mime_type,
  };
}

function adapterKey(transport: string, connectionKey: string): string {
  return `${transport}\u0000${connectionKey}`;
}
