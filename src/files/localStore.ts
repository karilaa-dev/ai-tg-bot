import { constants } from "node:fs";
import { link, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
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
        let existing: Buffer;
        try { existing = await this.read(key, signal); }
        catch (error) {
          if (error instanceof FileTooLargeError || hasCode(error, "ELOOP")) throw new LocalFileConflictError();
          throw error;
        }
        if (existing.length !== integrity.size || sha256Hex(existing) !== integrity.contentSha256) {
          throw new LocalFileConflictError();
        }
      }
      await this.syncDirectory();
      return integrity;
    } finally {
      await unlink(temporary);
    }
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
    try { await unlink(filename); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    await this.syncDirectory();
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
