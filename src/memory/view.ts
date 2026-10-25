import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../db/sql.js";
import { decode } from "./optmem/records.js";

export interface SavedMemory { id: number; date: string; text: string }
export interface MemoryPage { items: SavedMemory[]; total: number; nextOffset: number | null }

// Viewing saved notes is independent of the agent's memory on/off preference.
export async function readUserMemories(db: SqlExecutor, userId: number, offset: number, limit: number): Promise<MemoryPage> {
  const count = await queryOne<{ total: number }>(db, sql`select count(*) as total from optmem_notes where user_id = ${userId} and deleted = 0`);
  const total = Number(count?.total ?? 0);
  const rows = await db.query<{ id: number; date: string; content: Uint8Array }>(sql`
    select id, date, content from optmem_notes
    where user_id = ${userId} and deleted = 0
    order by id limit ${limit + 1} offset ${offset}
  `);
  return { items: rows.slice(0, limit).map(row => ({ id: row.id, date: row.date, text: decode(row.content) })),
    total, nextOffset: rows.length > limit ? offset + limit : null };
}

export async function deleteUserMemory(db: SqlExecutor, userId: number, memoryId: number): Promise<boolean> {
  return db.transaction(async tx => {
    await queryOne(tx, sql`select tg_id from users where tg_id = ${userId} ${tx.dialect === "postgres" ? sql`for update` : sql``}`);
    await queryOne(tx, sql`select user_id from optmem_stores where user_id = ${userId} ${tx.dialect === "postgres" ? sql`for update` : sql``}`);
    const note = await queryOne<{ deleted: number }>(tx, sql`select deleted from optmem_notes where user_id = ${userId} and id = ${memoryId}`);
    if (!note) return false;
    if (note.deleted) return true;
    // Keep stable note IDs and the dense summary tree, but erase the saved text.
    await tx.execute(sql`update optmem_notes set content = ${Buffer.alloc(0)}, deleted = 1 where user_id = ${userId} and id = ${memoryId}`);
    await tx.execute(sql`delete from optmem_summaries where user_id = ${userId}`);
    await tx.execute(sql`update optmem_stores set revision = revision + 1 where user_id = ${userId}`);
    return true;
  });
}
