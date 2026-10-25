import { sha256Hex } from "./hash.js";

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
  ) {}

  async resolveFile(file: FileRow, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES, policy?: FileReadPolicy): Promise<ResolvedChatFile> {
    const sources = await this.files.listSources(file.id);
    sources.sort((a, b) => Number(b.transport === "web") - Number(a.transport === "web")
      || (policy ? Number(a.transport === "e2b") - Number(b.transport === "e2b") : 0));
    const errors: string[] = [];
    let consentRequired = false;
    for (const source of sources) {
      try {
        const resolved = await this.resolveSource(rowToSource(source), signal, maxBytes, policy);
        if (source.transport === "e2b" || source.transport === "web") assertCanonicalSourceIntegrity(file, resolved);
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

function assertCanonicalSourceIntegrity(file: FileRow, resolved: ResolvedChatFile): void {
  if (resolved.size !== file.size) {
    throw new Error(`${resolved.source.transport} source size mismatch for file #${file.id}.`);
  }
  if (file.content_sha256 && resolved.contentSha256 !== file.content_sha256) {
    throw new Error(`${resolved.source.transport} source hash mismatch for file #${file.id}.`);
  }
}

function rowToSource(row: FileSourceRow): ChatFileSource {
  let locator: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.locator_json) as unknown;
    locator = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    locator = {};
  }
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
