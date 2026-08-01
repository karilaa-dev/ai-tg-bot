import { createHash } from "node:crypto";
import type { FileRow, FileSourceRow } from "../db/types.js";
import type { FilesRepo } from "../db/repos/files.js";
import { isAbortError, throwIfAborted } from "./cancel.js";
import { MAX_FILE_BYTES } from "./limits.js";
import {
  type ChatFileSource,
  type ChatFileSourceAdapter,
  type ResolvedChatFile,
} from "./source.js";

export class FileSourceRegistry {
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

  async resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const sources = await this.files.listSources(file.id);
    const errors: string[] = [];
    for (const source of sources) {
      try {
        const resolved = await this.resolveSource(rowToSource(source), signal);
        await this.files.markSourceVerified(source.id).catch(() => undefined);
        return resolved;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        errors.push(`${source.transport}/${source.connection_key}: ${String(error)}`);
      }
    }
    throw new Error(errors.length
      ? `No source for file #${file.id} could be loaded (${errors.join("; ")}).`
      : `File #${file.id} has no durable source.`);
  }

  async resolveSource(source: ChatFileSource, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const adapter = this.registry.get(source);
    if (!adapter) throw new Error(`No ${source.transport}/${source.connectionKey} file adapter is configured.`);
    throwIfAborted(signal);
    const payload = await adapter.fetch(source, signal);
    throwIfAborted(signal);
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (bytes.length > MAX_FILE_BYTES) throw new Error("File exceeds the configured size limit.");
    return {
      bytes,
      mimeType: source.mimeType ?? null,
      size: bytes.length,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      source,
    };
  }
}

export function rowToSource(row: FileSourceRow): ChatFileSource {
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
