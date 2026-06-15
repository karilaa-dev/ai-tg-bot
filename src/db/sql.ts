import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { DialectName } from "./types.js";

export interface SqlExecutor {
  dialect: DialectName;
  query<T extends object>(statement: SQL): Promise<T[]>;
  execute(statement: SQL): Promise<void>;
  destroy(): Promise<void>;
}

export function valueList(values: readonly unknown[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

export async function queryOne<T extends object>(
  db: SqlExecutor,
  statement: SQL,
): Promise<T | undefined> {
  const rows = await db.query<T>(statement);
  return rows[0];
}

export function normalizeRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      normalized[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
    }
    return normalized as T;
  });
}
