import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { FileRow, FileSourceRow } from "../db/types.js";
import type { FilesRepo } from "../db/repos/files.js";
import { FileByteCache } from "./cache.js";
import { isAbortError } from "./cancel.js";
import {
  sourceIdentity,
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
    private readonly cache: FileByteCache,
    readonly registry = new FileSourceRegistry(),
  ) {}

  async resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const sources = await this.files.listSources(file.id);
    if (!sources.length && file.path) {
      const bytes = await fs.readFile(file.path);
      return {
        path: file.path,
        bytes,
        mimeType: file.mime_type,
        size: bytes.length,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        expiresAt: Number.POSITIVE_INFINITY,
        source: {
          transport: "local",
          connectionKey: "managed",
          remoteKey: String(file.id),
          locator: { path: file.path },
          mimeType: file.mime_type,
        },
      };
    }
    const errors: string[] = [];
    for (const source of sources) {
      try {
        const resolved = await this.resolveSource(rowToSource(source), signal);
        await this.files.markSourceVerified(source.id).catch(() => undefined);
        return resolved;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        errors.push(`${source.transport}/${source.connection_key}`);
      }
    }
    throw new Error(errors.length
      ? `No remote source for file #${file.id} could be loaded (${errors.join("; ")}).`
      : `File #${file.id} has no remote or local source.`);
  }

  async resolveSource(source: ChatFileSource, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const adapter = this.registry.get(source);
    if (!adapter) throw new Error(`No ${source.transport}/${source.connectionKey} file adapter is configured.`);
    const cached = await this.cache.getOrLoad(
      sourceIdentity(source),
      (sharedSignal) => adapter.fetch(source, sharedSignal),
      signal,
    );
    return {
      ...cached,
      mimeType: source.mimeType ?? null,
      size: cached.bytes.length,
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
