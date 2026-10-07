import type { Block } from "./blocks.js";
import type { Memory } from "./records.js";

export interface MemoryStore {
  open(): Promise<void>;
  initialize(): Promise<boolean>;
  length(): Promise<number>;
  slice(lo: number, hi: number): Promise<Memory[]>;
  get(index: number): Promise<Memory>;
  scan(): AsyncGenerator<Memory>;
  summary(lo: number, hi: number): Promise<string | undefined>;
  append(items: ReadonlyArray<readonly [date: string, text: string]>): Promise<number>;
  put(lo: number, hi: number, text: string): Promise<boolean>;
  drop(lo: number, hi: number): Promise<Block[]>;
  pending(total: number, limit?: number): Promise<Block[]>;
  pendingCount(total: number): Promise<number>;
}
