import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./sql.js";

/** Repair only identities invalidated by legacy writers, using JavaScript's Unicode mapping. */
export async function refreshPostgresUserSearch(db: SqlExecutor): Promise<void> {
  while (true) {
    const users = await db.query<{ tg_id: number; first_name: string | null; username: string | null }>(sql`
      select tg_id, first_name, username from users
      where first_name_search is null or username_search is null order by tg_id limit 500
    `);
    if (!users.length) return;
    const values = sql.join(users.map(user => sql`(
      ${user.tg_id}::bigint, ${(user.first_name ?? "").toLowerCase()}::text, ${(user.username ?? "").toLowerCase()}::text,
      ${user.first_name}::text, ${user.username}::text
    )`), sql`, `);
    // A legacy process may rename a user between the read and update. Only
    // publish normalization for the identity we read, then retry any dirty row.
    await db.execute(sql`
      update users u set first_name_search = normalized.name, username_search = normalized.username
      from (values ${values}) as normalized(id, name, username, original_name, original_username)
      where u.tg_id = normalized.id
        and u.first_name is not distinct from normalized.original_name
        and u.username is not distinct from normalized.original_username
        and (u.first_name_search is null or u.username_search is null)
    `);
  }
}
