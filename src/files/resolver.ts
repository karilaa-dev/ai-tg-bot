import { createHash } from "node:crypto";
import type { FileRow, FileSourceRow } from "../db/types.js";
import type { FilesRepo } from "../db/repos/files.js";
import { FileByteCache } from "./cache.js";
import { isAbortError } from "./cancel.js";
import { ManagedFileStore } from "./storage.js";
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
    private readonly store: ManagedFileStore,
    readonly registry = new FileSourceRegistry(),
  ) {}

  async resolveFile(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile> {
    const local = await this.resolveLocal(file, signal);
    if (local) return local;
    const sources = await this.files.listSources(file.id);
    const errors: string[] = [];
    for (const source of sources) {
      try {
        const resolved = await this.resolveSource(rowToSource(source), signal);
        await this.files.markSourceVerified(source.id).catch(() => undefined);
        try {
          const managedPath = await this.store.write(file.id, resolved.bytes);
          await this.files.setPath(file.id, managedPath);
          return localResult(file, managedPath, resolved.bytes, resolved.mimeType, resolved.source);
        } catch {
          return resolved;
        }
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        errors.push(`${source.transport}/${source.connection_key}`);
      }
    }
    throw new Error(errors.length
      ? `No remote source for file #${file.id} could be loaded (${errors.join("; ")}).`
      : `File #${file.id} has no remote or local source.`);
  }

  private async resolveLocal(file: FileRow, signal?: AbortSignal): Promise<ResolvedChatFile | undefined> {
    throwIfAborted(signal);
    if (file.path) {
      const known = await this.store.readKnownPath(file.id, file.path);
      throwIfAborted(signal);
      if (known) {
        if (!known.managed) {
          try {
            const managedPath = await this.store.write(file.id, known.bytes);
            await this.files.setPath(file.id, managedPath);
            return localResult(file, managedPath, known.bytes, file.mime_type);
          } catch {
            return localResult(file, known.path, known.bytes, file.mime_type);
          }
        }
        return localResult(file, known.path, known.bytes, file.mime_type);
      }
      await this.files.clearPath(file.id).catch(() => undefined);
    }
    const managed = await this.store.readManaged(file.id);
    throwIfAborted(signal);
    if (!managed) return undefined;
    await this.files.setPath(file.id, managed.path).catch(() => undefined);
    return localResult(file, managed.path, managed.bytes, file.mime_type);
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

function localResult(
  file: FileRow,
  filePath: string,
  bytes: Buffer,
  mimeType: string | null,
  source?: ChatFileSource,
): ResolvedChatFile {
  return {
    path: filePath,
    bytes,
    mimeType,
    size: bytes.length,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    expiresAt: Number.POSITIVE_INFINITY,
    source: source ?? {
      transport: "local",
      connectionKey: "managed",
      remoteKey: String(file.id),
      locator: { file_id: file.id },
      mimeType,
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("File loading aborted", "AbortError");
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
