import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./sql.js";

export async function lockThreadTransaction(tx: SqlExecutor, threadId: number): Promise<void> {
  if (tx.dialect !== "postgres") return;
  // Message allocation must commit in order within each thread so a read
  // cursor cannot pass an earlier message still being indexed by another writer.
  await tx.execute(sql`
    select pg_advisory_xact_lock(938472616, cast(mod(${threadId}, 2147483647) as integer))
  `);
}
