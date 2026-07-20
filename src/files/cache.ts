import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { AppConfig } from "../config.js";
import { MAX_FILE_BYTES } from "./limits.js";

export interface CachedFileBytes {
  path: string;
  bytes: Buffer;
  contentSha256: string;
  expiresAt: number;
}

interface InflightLoad {
  promise: Promise<CachedFileBytes>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

export class FileByteCache {
  private readonly root: string;
  private readonly ttlMs: number;
  private readonly inflight = new Map<string, InflightLoad>();
  private initialized?: Promise<void>;
  private lastSweepAt = 0;

  constructor(config: Pick<AppConfig, "FILE_CACHE_DIR" | "FILE_CACHE_TTL_MS">) {
    this.root = path.resolve(config.FILE_CACHE_DIR);
    this.ttlMs = config.FILE_CACHE_TTL_MS;
  }

  async getOrLoad(
    identity: string,
    loader: (signal?: AbortSignal) => Promise<Buffer | Uint8Array | Readable>,
    signal?: AbortSignal,
  ): Promise<CachedFileBytes> {
    await this.ensureInitialized();
    throwIfAborted(signal);
    const key = cacheKey(identity);
    let inflight = this.inflight.get(key);
    if (!inflight) {
      const controller = new AbortController();
      const basePromise = this.load(key, () => loader(controller.signal), controller.signal);
      const entry: InflightLoad = {
        controller,
        waiters: 0,
        settled: false,
        promise: basePromise,
      };
      entry.promise = basePromise.finally(() => {
        entry.settled = true;
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
      this.inflight.set(key, entry);
      inflight = entry;
    }
    inflight.waiters += 1;
    try {
      return await waitForCaller(inflight.promise, signal);
    } finally {
      inflight.waiters -= 1;
      if (!inflight.settled && inflight.waiters === 0) {
        inflight.controller.abort(new DOMException("File loading abandoned", "AbortError"));
      }
    }
  }

  async get(identity: string, signal?: AbortSignal): Promise<CachedFileBytes | undefined> {
    await this.ensureInitialized();
    throwIfAborted(signal);
    return this.readFresh(path.join(this.root, cacheKey(identity)), signal);
  }

  async sweep(now = Date.now()): Promise<number> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("File cache root must be a real directory.");
    }
    await fs.chmod(this.root, 0o700);
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      const filePath = path.join(this.root, entry.name);
      if (entry.isSymbolicLink()) {
        await fs.unlink(filePath).catch(() => undefined);
        removed += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (!stat) continue;
      if (entry.name.includes(".part-") || stat.mtimeMs + this.ttlMs <= now) {
        await fs.unlink(filePath).catch(() => undefined);
        removed += 1;
      }
    }
    this.lastSweepAt = now;
    return removed;
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.sweep().then(() => undefined);
    await this.initialized;
    if (Date.now() - this.lastSweepAt >= Math.min(this.ttlMs, 10 * 60_000)) await this.sweep();
  }

  private async load(
    key: string,
    loader: () => Promise<Buffer | Uint8Array | Readable>,
    signal?: AbortSignal,
  ): Promise<CachedFileBytes> {
    const finalPath = path.join(this.root, key);
    const cached = await this.readFresh(finalPath, signal);
    if (cached) return cached;
    const partPath = `${finalPath}.part-${process.pid}-${randomUUID()}`;
    try {
      const bytes = await payloadBuffer(await loader(), signal);
      if (bytes.length > MAX_FILE_BYTES) throw new Error("File exceeds the configured size limit.");
      throwIfAborted(signal);
      await fs.writeFile(partPath, bytes, { mode: 0o600 });
      await fs.rename(partPath, finalPath);
      const completedAt = Date.now();
      await fs.utimes(finalPath, completedAt / 1000, completedAt / 1000);
      return cachedResult(finalPath, bytes, completedAt + this.ttlMs);
    } finally {
      await fs.unlink(partPath).catch(() => undefined);
    }
  }

  private async readFresh(filePath: string, signal?: AbortSignal): Promise<CachedFileBytes | undefined> {
    const stat = await fs.lstat(filePath).catch(() => undefined);
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      await fs.unlink(filePath).catch(() => undefined);
      return undefined;
    }
    const expiresAt = stat.mtimeMs + this.ttlMs;
    if (expiresAt <= Date.now() || stat.size > MAX_FILE_BYTES) {
      await fs.unlink(filePath).catch(() => undefined);
      return undefined;
    }
    await fs.chmod(filePath, 0o600);
    throwIfAborted(signal);
    const bytes = await fs.readFile(filePath);
    throwIfAborted(signal);
    return cachedResult(filePath, bytes, expiresAt);
  }
}

function cacheKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function cachedResult(filePath: string, bytes: Buffer, expiresAt: number): CachedFileBytes {
  return {
    path: filePath,
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    expiresAt,
  };
}

async function payloadBuffer(payload: Buffer | Uint8Array | Readable, signal?: AbortSignal): Promise<Buffer> {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    throwIfAborted(signal);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_FILE_BYTES) throw new Error("File exceeds the configured size limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("File loading aborted", "AbortError");
}

async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("File loading aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
