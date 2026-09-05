import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreatedFileAttachment } from "./types.js";
import { raceWithAbort } from "./cancel.js";

export const OUTGOING_BUFFER_BYTES = 40 * 1024 * 1024;
const FILE_PREPARATION_WORKERS = 2;

interface OutgoingReservation {
  commit(attachment: CreatedFileAttachment, bytes: Buffer, pinned?: boolean): void;
  release(): void;
}

/** One budget for export reservations, reusable bytes, prefetch and active uploads. */
export class OutgoingBuffers {
  private used = 0;
  private peak = 0;
  private closed = false;
  private readonly entries = new Map<CreatedFileAttachment, { size: number; pinned: boolean }>();
  private readonly spooled = new Map<CreatedFileAttachment, string>();
  private directory?: Promise<string>;
  private changed = notification();

  constructor(readonly limit = OUTGOING_BUFFER_BYTES) {}

  snapshot() { return { bufferedBytes: this.used, peakBufferedBytes: this.peak }; }

  async reserve(size: number, signal?: AbortSignal): Promise<OutgoingReservation> {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limit) throw new Error("File exceeds outgoing buffer budget.");
    while (true) {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Outgoing buffers are closed.");
      for (const [attachment, entry] of this.entries) {
        if (this.used + size <= this.limit) break;
        if (!entry.pinned) this.release(attachment);
      }
      if (this.used + size <= this.limit) break;
      await raceWithAbort(this.changed.promise, signal);
    }
    this.used += size;
    this.peak = Math.max(this.peak, this.used);
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      this.used -= size;
      this.wake();
    };
    return {
      release,
      commit: (attachment, bytes, pinned = false) => {
        if (!active || this.closed) throw new Error("Outgoing reservation is no longer active.");
        if (bytes.length > size) throw new Error("File exceeded its reserved outgoing size.");
        this.release(attachment);
        this.used -= size - bytes.length;
        active = false;
        attachment.data = bytes;
        this.entries.set(attachment, { size: bytes.length, pinned });
        this.wake();
      },
    };
  }

  /** Non-workspace outputs have no durable source yet; spill before allowing eviction. */
  async spool(attachment: CreatedFileAttachment, bytes: Buffer): Promise<void> {
    this.directory ??= fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-outgoing-"));
    const filename = path.join(await this.directory, `${attachment.fileId}`);
    await fs.writeFile(filename, bytes, { mode: 0o600 });
    this.spooled.set(attachment, filename);
  }

  async readSpool(attachment: CreatedFileAttachment, signal?: AbortSignal): Promise<Buffer | undefined> {
    const source = this.spooled.get(attachment);
    return source ? fs.readFile(source, { signal }) : undefined;
  }

  async load(attachment: CreatedFileAttachment, loader: () => Promise<Buffer>, signal?: AbortSignal): Promise<void> {
    const entry = this.entries.get(attachment);
    if (entry && attachment.data) { entry.pinned = true; return; }
    const reservation = await this.reserve(attachment.size, signal);
    try {
      const source = this.spooled.get(attachment);
      const bytes = attachment.data ?? (source ? await fs.readFile(source, { signal }) : await loader());
      signal?.throwIfAborted();
      reservation.commit(attachment, bytes, true);
    } finally { reservation.release(); }
  }

  release(attachment: CreatedFileAttachment): void {
    const entry = this.entries.get(attachment);
    if (entry) this.used -= entry.size;
    this.entries.delete(attachment);
    attachment.data = undefined;
    this.wake();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const attachment of this.entries.keys()) this.release(attachment);
    this.wake();
    if (this.directory) await fs.rm(await this.directory, { recursive: true, force: true });
    this.spooled.clear();
  }

  private wake(): void {
    const changed = this.changed;
    this.changed = notification();
    changed.resolve();
  }
}

function notification(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function prepareWithTwoWorkers<T, R>(items: readonly T[], prepare: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FILE_PREPARATION_WORKERS, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await prepare(items[index]!, index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}
