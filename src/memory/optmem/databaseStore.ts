import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../../db/sql.js";
import type { Block } from "./blocks.js";
import { decode, MemoError, pad, precedes, LOG_REC, TREE_REC, type Memory } from "./records.js";
import type { MemoryStore } from "./storage.js";

export class DatabaseMemoryStore implements MemoryStore {
  constructor(private readonly db: SqlExecutor, readonly userId: number, private readonly signal?: AbortSignal) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid memory owner.");
  }

  private async assertEnabled(db = this.db, lock = false): Promise<void> {
    this.signal?.throwIfAborted();
    const user = await queryOne<{ memory_enabled: number }>(db, sql`select memory_enabled from users
      where tg_id = ${this.userId} ${lock && db.dialect === "postgres" ? sql`for update` : sql``}`);
    this.signal?.throwIfAborted();
    if (!user?.memory_enabled) throw new MemoError("Memory is disabled. The user can enable it with /memory on.");
  }

  async exists(): Promise<boolean> {
    return Boolean(await queryOne(this.db, sql`select user_id from optmem_stores where user_id = ${this.userId}`));
  }

  async open(): Promise<void> {
    await this.assertEnabled();
    if (!await this.exists()) throw new MemoError(`No memory for user ${this.userId}. Initialize this user's memory first.`);
  }

  async initialize(): Promise<boolean> {
    return this.db.transaction(async tx => {
      await this.assertEnabled(tx, true);
      const created = await queryOne(tx, sql`insert into optmem_stores(user_id) values (${this.userId})
        on conflict(user_id) do nothing returning user_id`);
      return Boolean(created);
    });
  }

  private async locked<T>(action: (store: DatabaseMemoryStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      await this.assertEnabled(tx, true);
      const row = await queryOne(tx, sql`select next_id from optmem_stores where user_id = ${this.userId}
        ${tx.dialect === "postgres" ? sql`for update` : sql``}`);
      if (!row) throw new MemoError(`No memory for user ${this.userId}. Initialize this user's memory first.`);
      return action(new DatabaseMemoryStore(tx, this.userId, this.signal));
    });
  }

  async length(): Promise<number> {
    const row = await queryOne<{ next_id: number }>(this.db, sql`select next_id from optmem_stores where user_id = ${this.userId}`);
    return row?.next_id ?? 0;
  }

  async slice(lo: number, hi: number): Promise<Memory[]> {
    await this.assertEnabled();
    const rows = await this.db.query<{ id: number; date: string; content: Buffer }>(sql`
      select id, date, content from optmem_notes where user_id = ${this.userId} and id >= ${lo} and id < ${hi} order by id
    `);
    return rows.map(row => [row.id, row.date, decode(row.content)]);
  }

  async get(index: number): Promise<Memory> {
    const [entry] = await this.slice(index, index + 1);
    if (!entry) throw new MemoError(`Missing memory #${index}.`);
    return entry;
  }

  async *scan(): AsyncGenerator<Memory> {
    let lo = 0;
    while (true) {
      const rows = await this.slice(lo, lo + 4096);
      if (!rows.length) return;
      yield* rows;
      lo = rows[rows.length - 1][0] + 1;
    }
  }

  async summary(lo: number, hi: number): Promise<string | undefined> {
    await this.assertEnabled();
    const row = await queryOne<{ content: Buffer }>(this.db, sql`select content from optmem_summaries
      where user_id = ${this.userId} and size = ${hi - lo} and block_index = ${lo / (hi - lo)}`);
    return row ? decode(row.content) : undefined;
  }

  async append(items: ReadonlyArray<readonly [date: string, text: string]>, options?: Parameters<MemoryStore["append"]>[1]): Promise<number> {
    return this.locked(async store => {
      const base = await store.length();
      const [first] = items;
      if (options?.chronological && first && base) {
        const [, previousDate] = await store.get(base - 1);
        if (precedes(first[0], previousDate)) {
          throw new MemoError(`Import date ${first[0]} precedes the previous memory (${previousDate}).`);
        }
      }
      for (const [i, [date, text]] of items.entries()) {
        pad(`#${base + i} ${date} ${text}`, LOG_REC);
        await store.db.execute(sql`insert into optmem_notes(user_id, id, date, content)
          values (${this.userId}, ${base + i}, ${date}, ${Buffer.from(text)})`);
      }
      await store.db.execute(sql`update optmem_stores set next_id = ${base + items.length} where user_id = ${this.userId}`);
      return base;
    });
  }

  private async levelLength(size: number): Promise<number> {
    const row = await queryOne<{ n: number }>(this.db, sql`select count(*) as n from optmem_summaries
      where user_id = ${this.userId} and size = ${size}`);
    return row?.n ?? 0;
  }

  async put(lo: number, hi: number, text: string): Promise<boolean> {
    return this.locked(async store => {
      // Earlier levels include the children; forgetting one makes it pending
      // again and prevents an in-flight parent from bypassing the rebuild.
      const [next] = await store.pending(await store.length(), 1);
      if (!next || next[0] !== lo || next[1] !== hi) return false;
      const size = hi - lo, index = lo / size;
      pad(text, TREE_REC);
      await store.db.execute(sql`insert into optmem_summaries(user_id, size, block_index, content)
        values (${this.userId}, ${size}, ${index}, ${Buffer.from(text)})`);
      return true;
    });
  }

  async drop(lo: number, hi: number): Promise<Block[]> {
    return this.locked(async store => {
      const gone: Block[] = [], total = await store.length();
      for (let size = hi - lo; size <= total; size *= 2) {
        const k = Math.floor(lo / size), n = await store.levelLength(size);
        for (let i = k; i < n; i++) gone.push([i * size, (i + 1) * size]);
        await store.db.execute(sql`delete from optmem_summaries where user_id = ${this.userId} and size = ${size} and block_index >= ${k}`);
      }
      return gone;
    });
  }

  async pending(total: number, limit?: number): Promise<Block[]> {
    const todo: Block[] = [];
    for (let size = 2; size <= total; size *= 2) {
      for (let k = await this.levelLength(size); k < Math.floor(total / size); k++) {
        todo.push([k * size, (k + 1) * size]);
        if (limit && todo.length >= limit) return todo;
      }
    }
    return todo;
  }

  async pendingCount(total: number): Promise<number> {
    let count = 0;
    for (let size = 2; size <= total; size *= 2) count += Math.max(0, Math.floor(total / size) - await this.levelLength(size));
    return count;
  }
}
