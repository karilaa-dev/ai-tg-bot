import fs from "node:fs/promises";
import path from "node:path";
import { openLock, Lock } from "@lickle/lock";
import type { Block } from "./blocks.js";

export const LOG_REC = 320;
export const TREE_REC = 288;
export class MemoError extends Error {}
export type Memory = readonly [id: number, date: string, text: string];

// Python str.strip's whitespace set; JS trim also removes BOM and omits NEL.
const SPACE = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const strip = (text: string): string => text.replace(new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu"), "");
const rstrip = (text: string): string => text.replace(new RegExp(`[${SPACE}]+$`, "u"), "");
export const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function pad(text: string, width: number): Buffer {
  const bytes = Buffer.from(text);
  if (bytes.length > width - 1) throw new MemoError(`Too long: ${bytes.length} bytes. The record holds ${width - 1}.`);
  const record = Buffer.alloc(width, 32);
  bytes.copy(record);
  record[width - 1] = 10;
  return record;
}

async function count(file: string, width: number): Promise<number> {
  try { return Math.floor((await fs.stat(file)).size / width); }
  catch (error) { if (isMissing(error)) return 0; throw error; }
}

async function repair(file: string, width: number): Promise<void> {
  try {
    const size = (await fs.stat(file)).size;
    if (size % width) await fs.truncate(file, size - size % width);
  } catch (error) { if (!isMissing(error)) throw error; }
}

async function read(file: fs.FileHandle, buffer: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset;
}

function records(buffer: Buffer): Memory[] {
  const entries: Memory[] = [];
  for (let offset = 0; offset + LOG_REC <= buffer.length; offset += LOG_REC) {
    const line = rstrip(decode(buffer.subarray(offset, offset + LOG_REC)));
    const match = /^#(\d+) ([^ ]+) (.*)$/su.exec(line);
    if (!match) throw new MemoError("Invalid memory record in LOG.txt.");
    entries.push([Number(match[1]), match[2], match[3]]);
  }
  return entries;
}

export class Store {
  constructor(readonly directory: string, private readonly command: string) {}
  private get log(): string { return path.join(this.directory, "LOG.txt"); }
  private tree(size: number): string { return path.join(this.directory, "TREE", String(size)); }

  async open(): Promise<void> {
    let exists = false;
    try { exists = (await fs.stat(this.directory)).isDirectory(); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (!exists) throw new MemoError(`No memory at ${this.directory}.\nTo create one, run: ${this.command} init\nTo use an existing one, point MEMORY_DIR at it.`);
    await fs.mkdir(path.join(this.directory, "TREE"), { recursive: true });
    await (await fs.open(this.log, "a")).close();
  }

  async initialize(): Promise<boolean> {
    let fresh = true;
    try { fresh = !(await fs.stat(this.directory)).isDirectory(); }
    catch (error) { if (!isMissing(error)) throw error; }
    await fs.mkdir(path.join(this.directory, "TREE"), { recursive: true, mode: 0o700 });
    await (await fs.open(this.log, "a", 0o600)).close();
    return fresh;
  }

  async locked<T>(action: () => Promise<T>): Promise<T> {
    // Kernel locks survive process suspension and release on death, like upstream flock.
    const guard = await openLock(path.join(this.directory, ".lock"), Lock.Exclusive);
    try { return await action(); }
    finally { await guard.drop(); }
  }

  length(): Promise<number> { return count(this.log, LOG_REC); }

  async slice(lo: number, hi: number): Promise<Memory[]> {
    const file = await fs.open(this.log, "r");
    try {
      const buffer = Buffer.alloc((hi - lo) * LOG_REC);
      const bytesRead = await read(file, buffer, lo * LOG_REC);
      return records(buffer.subarray(0, bytesRead));
    } finally { await file.close(); }
  }

  async get(index: number): Promise<Memory> {
    const [entry] = await this.slice(index, index + 1);
    if (!entry) throw new MemoError(`Missing memory #${index} in LOG.txt.`);
    return entry;
  }

  async *scan(): AsyncGenerator<Memory> {
    const file = await fs.open(this.log, "r");
    try {
      const buffer = Buffer.alloc(LOG_REC * 4096);
      let position = 0;
      while (true) {
        const bytesRead = await read(file, buffer, position);
        if (!bytesRead) return;
        yield* records(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally { await file.close(); }
  }

  async summary(lo: number, hi: number): Promise<string | undefined> {
    const size = hi - lo;
    let file;
    try { file = await fs.open(this.tree(size), "r"); }
    catch (error) { if (isMissing(error)) return; throw error; }
    try {
      const buffer = Buffer.alloc(TREE_REC);
      const bytesRead = await read(file, buffer, Math.floor(lo / size) * TREE_REC);
      try { return rstrip(decode(buffer.subarray(0, bytesRead))) || undefined; }
      catch { throw new MemoError(`The summary of #${lo}-${hi - 1} is corrupt. Run: ${this.command} forget ${lo}-${hi - 1}`); }
    } finally { await file.close(); }
  }

  async append(items: ReadonlyArray<readonly [date: string, text: string]>): Promise<number> {
    return this.locked(async () => {
      await repair(this.log, LOG_REC);
      const base = await this.length();
      const file = await fs.open(this.log, "a");
      try {
        for (const [i, [date, text]] of items.entries()) await file.writeFile(pad(`#${base + i} ${date} ${text}`, LOG_REC));
        await file.sync();
      } finally { await file.close(); }
      return base;
    });
  }

  async put(lo: number, hi: number, text: string): Promise<boolean> {
    const size = hi - lo;
    return this.locked(async () => {
      const target = this.tree(size);
      await repair(target, TREE_REC);
      if (await count(target, TREE_REC) !== Math.floor(lo / size)) return false;
      const file = await fs.open(target, "a", 0o600);
      try { await file.writeFile(pad(text, TREE_REC)); await file.sync(); }
      finally { await file.close(); }
      return true;
    });
  }

  async drop(lo: number, hi: number): Promise<Block[]> {
    return this.locked(async () => {
      const gone: Block[] = [];
      for (let size = hi - lo; size <= await this.length(); size *= 2) {
        const target = this.tree(size), k = Math.floor(lo / size);
        const n = await count(target, TREE_REC);
        if (n <= k) continue;
        for (let i = k; i < n; i++) gone.push([i * size, (i + 1) * size]);
        await fs.truncate(target, k * TREE_REC);
      }
      return gone;
    });
  }

  async pending(total: number, limit?: number): Promise<Block[]> {
    const todo: Block[] = [];
    for (let size = 2; size <= total; size *= 2) {
      const have = await count(this.tree(size), TREE_REC);
      for (let k = have; k < Math.floor(total / size); k++) {
        todo.push([k * size, (k + 1) * size]);
        if (limit && todo.length >= limit) return todo;
      }
    }
    return todo;
  }

  async pendingCount(total: number): Promise<number> {
    let n = 0;
    for (let size = 2; size <= total; size *= 2) n += Math.max(0, Math.floor(total / size) - await count(this.tree(size), TREE_REC));
    return n;
  }
}
