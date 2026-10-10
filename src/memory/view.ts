import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../db/sql.js";
import { decode } from "./optmem/records.js";

export interface SavedMemory { id: number; date: string; text: string }
export interface MemoryPage { items: SavedMemory[]; total: number; nextOffset: number | null }

// Viewing saved notes is independent of the agent's memory on/off preference.
export async function readUserMemories(db: SqlExecutor, userId: number, offset: number, limit: number): Promise<MemoryPage> {
  const store = await queryOne<{ next_id: number }>(db, sql`select next_id from optmem_stores where user_id = ${userId}`);
  const total = store?.next_id ?? 0;
  const rows = await db.query<{ id: number; date: string; content: Uint8Array }>(sql`
    select id, date, content from optmem_notes
    where user_id = ${userId} and id >= ${offset} and id < ${total}
    order by id limit ${limit}
  `);
  const next = (rows.at(-1)?.id ?? total) + 1;
  return { items: rows.map(row => ({ id: row.id, date: row.date, text: decode(row.content) })),
    total, nextOffset: next < total ? next : null };
}
