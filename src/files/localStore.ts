import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { throwIfAborted } from "./cancel.js";
import { sha256Hex } from "./hash.js";
import { FileTooLargeError, MAX_FILE_BYTES } from "./limits.js";
import { isUuid } from "../utils/uuid.js";

export interface LocalFileIntegrity {
  size: number;
  contentSha256: string;
}

export class LocalFileConflictError extends Error {
  constructor() { super("Local attachment already contains different bytes."); }
}

export function localFileKey(value: string): string {
  if (!isUuid(value)) {
    throw new Error("Invalid local file UUID.");
  }
  return value.toLowerCase();
}

/** Immutable attachment bytes; display names never participate in host paths. */
export class LocalFileStore {
  private directory?: Promise<string>;

  constructor(readonly rootDirectory: string) {}

  async read(key: string, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
    const filename = await this.filename(key);
    throwIfAborted(signal);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Local attachment is not a regular file.");
      if (stat.size > MAX_FILE_BYTES || stat.size > maxBytes) throw new FileTooLargeError();
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        throwIfAborted(signal);
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new Error("Local attachment changed while reading.");
        offset += result.bytesRead;
      }
      const trailing = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (trailing.bytesRead) throw new Error("Local attachment changed while reading.");
      throwIfAborted(signal);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async write(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<LocalFileIntegrity> {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new FileTooLargeError();
    const filename = await this.filename(key);
    const integrity = { size: bytes.byteLength, contentSha256: sha256Hex(bytes) };
    throwIfAborted(signal);
    // Repeated persistence of the same attachment is common (preparation, then delivery). Only the bytes on disk
    // prove they exist, so verify them instead of staging and fsyncing another full copy.
    if (await this.hasIntegrity(key, integrity, signal)) {
      throwIfAborted(signal);
      // The publisher that linked this file may not have synced the directory yet; only the entry needs it.
      await this.syncDirectory();
      return integrity;
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes, { signal });
      await handle.sync();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    try {
      throwIfAborted(signal);
      try {
        await link(temporary, filename);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        // Another writer published between the check above and now.
        if (!await this.hasIntegrity(key, integrity, signal)) throw new LocalFileConflictError();
      }
      await this.syncDirectory();
      return integrity;
    } finally {
      await unlink(temporary);
    }
  }

  /**
   * Whether a canonical file exists with exactly these bytes. False means it is absent; different bytes, links and
   * oversized files are conflicts, and unreadable entries (such as directories) surface their own errors.
   */
  private async hasIntegrity(key: string, expected: LocalFileIntegrity, signal?: AbortSignal): Promise<boolean> {
    let existing: Buffer;
    try { existing = await this.read(key, signal, expected.size); }
    catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      if (error instanceof FileTooLargeError || hasCode(error, "ELOOP")) throw new LocalFileConflictError();
      throw error;
    }
    if (existing.length !== expected.size || sha256Hex(existing) !== expected.contentSha256) throw new LocalFileConflictError();
    return true;
  }

  /** Replace damaged bytes only after the caller verifies the canonical hash. */
  async repair(key: string, bytes: Uint8Array, expected: LocalFileIntegrity, signal?: AbortSignal): Promise<void> {
    assertLocalIntegrity(bytes, expected);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new FileTooLargeError();
    const filename = await this.filename(key);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    throwIfAborted(signal);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes, { signal });
      await handle.sync();
      throwIfAborted(signal);
      await rename(temporary, filename);
      await this.syncDirectory();
    } finally {
      await handle.close();
      await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
    }
  }

  async remove(key: string): Promise<void> {
    const filename = await this.filename(key);
    // A fence (see revoke) is already the end state; unlinking a directory would only fail.
    if (!await this.isFence(filename)) {
      try { await unlink(filename); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
    await this.removeStaging(key);
    await this.syncDirectory();
  }

  /**
   * Removes the bytes and makes it impossible for any writer, however late or stale, to publish this key again.
   *
   * Publication only ever happens by linking or renaming a staged copy onto the canonical name, so an empty
   * directory there is a fence: both operations fail on it, writes and reads refuse it, and nothing recreates
   * the file. The directory is installed first and anything a racing writer published in the meantime is
   * unlinked and the install retried, which terminates because a writer publishes at most once. The fence is
   * permanent and costs one empty directory entry; keys are random UUIDs, so it is never in the way.
   */
  async revoke(key: string): Promise<void> {
    const filename = await this.filename(key);
    for (let attempt = 0; ; attempt++) {
      try { await mkdir(filename, { mode: 0o700 }); break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (await this.isFence(filename)) break;
        if (attempt >= 8) throw new Error("Local attachment kept being republished while it was being revoked.");
        try { await unlink(filename); }
        catch (unlinkError) { if (!hasCode(unlinkError, "ENOENT")) throw unlinkError; }
      }
    }
    await this.removeStaging(key);
    await this.syncDirectory();
  }

  /**
   * Staging copies of fenced keys can only be left by writers that died after the fence was installed. They can
   * never be published, so they are removed; staging copies of other keys belong to writes in progress.
   */
  async sweepFencedStaging(): Promise<number> {
    const root = path.dirname(await this.filename(randomUUID()));
    const staging = /^([0-9a-f-]{36})\.[0-9a-f-]{36}\.tmp$/;
    let removed = 0;
    for (const entry of await readdir(root)) {
      const key = staging.exec(entry)?.[1];
      if (!key || !isUuid(key) || !await this.isFence(path.join(root, key))) continue;
      try { await unlink(path.join(root, entry)); removed++; }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
    return removed;
  }

  private async isFence(filename: string): Promise<boolean> {
    try { return (await lstat(filename)).isDirectory(); }
    catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** A writer that died mid-publication leaves staging copies named after the file; they are never read. */
  private async removeStaging(key: string): Promise<void> {
    const directory = path.dirname(await this.filename(key));
    const staging = new RegExp(`^${localFileKey(key)}\\.[0-9a-f-]{36}\\.tmp$`);
    for (const entry of await readdir(directory)) {
      if (!staging.test(entry)) continue;
      try { await unlink(path.join(directory, entry)); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
  }

  private async filename(key: string): Promise<string> {
    const name = localFileKey(key);
    this.directory ??= this.initializeDirectory();
    return path.join(await this.directory, name);
  }

  private async initializeDirectory(): Promise<string> {
    const root = path.resolve(this.rootDirectory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    return realpath(root);
  }

  private async syncDirectory(): Promise<void> {
    const root = await this.directory;
    if (!root) return;
    const handle = await open(root, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

export function assertLocalIntegrity(bytes: Uint8Array, expected: LocalFileIntegrity): void {
  if (bytes.byteLength !== expected.size) throw new Error("Local attachment size mismatch.");
  if (sha256Hex(bytes) !== expected.contentSha256) throw new Error("Local attachment hash mismatch.");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
