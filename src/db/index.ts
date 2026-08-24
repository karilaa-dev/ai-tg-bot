import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type SQL } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { initializeSchema } from "./schema.js";
import { createTextSearch, type TextSearch } from "./search.js";
import { normalizeRows, type SqlExecutor } from "./sql.js";
import type { DialectName } from "./types.js";

export interface AppDatabase {
  db: SqlExecutor;
  dialect: DialectName;
  search: TextSearch;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}

export function createDatabase(config: Pick<AppConfig, "DB_URL">, logger?: Logger): AppDatabase {
  const dialect = config.DB_URL.startsWith("postgres://") || config.DB_URL.startsWith("postgresql://")
    ? "postgres"
    : "sqlite";
  logger?.debug("creating database connection", { dialect });

  let db: SqlExecutor;
  if (dialect === "sqlite") {
    const target = config.DB_URL.replace(/^sqlite:/, "");
    const sqlitePath = target === ":memory:" ? ":memory:" : path.resolve(target);
    if (sqlitePath !== ":memory:") fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    logger?.debug("opening sqlite database", { path: sqlitePath });
    const sqlite = drizzleSqlite({ client: new Database(sqlitePath) });
    let operationTail = Promise.resolve();
    const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = operationTail;
      let release!: () => void;
      operationTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };
    const rawQuery = async <T extends object>(statement: SQL): Promise<T[]> =>
      normalizeRows(sqlite.all<T>(statement));
    const rawExecute = async (statement: SQL): Promise<void> => {
      sqlite.run(statement);
    };
    let transactionExecutor: SqlExecutor;
    transactionExecutor = {
      dialect,
      query: rawQuery,
      execute: rawExecute,
      // Nested repository transactions share the already-exclusive outer
      // transaction. A nested failure still rolls back the outer work.
      transaction: async <T>(callback: (tx: SqlExecutor) => Promise<T>) => callback(transactionExecutor),
      destroy: async () => undefined,
    };
    const sqliteExecutor: SqlExecutor = {
      dialect,
      query: <T extends object>(statement: SQL) => withLock(() => rawQuery<T>(statement)),
      execute: (statement: SQL) => withLock(() => rawExecute(statement)),
      transaction: async <T>(callback: (tx: SqlExecutor) => Promise<T>) => {
        return withLock(async () => {
          sqlite.$client.exec("begin immediate");
          try {
            const result = await callback(transactionExecutor);
            sqlite.$client.exec("commit");
            return result;
          } catch (error) {
            sqlite.$client.exec("rollback");
            throw error;
          }
        });
      },
      destroy: () => withLock(async () => {
        logger?.debug("closing sqlite database");
        sqlite.$client.close();
      }),
    };
    db = sqliteExecutor;
  } else {
    pg.types.setTypeParser(20, (value) => Number(value));
    logger?.debug("opening postgres database");
    const postgres = drizzlePg(config.DB_URL);
    db = postgresExecutor(postgres as unknown as PgDrizzleExecutor, async () => {
      logger?.debug("closing postgres database");
      await postgres.$client.end();
    });
  }

  return {
    db,
    dialect,
    search: createTextSearch(db, dialect),
    initialize: async () => {
      logger?.debug("database initialization starting", { dialect });
      await initializeSchema(db, dialect);
      logger?.info("database initialized", { dialect });
    },
    destroy: async () => {
      logger?.debug("database destroy starting", { dialect });
      await db.destroy();
      logger?.debug("database destroy complete", { dialect });
    },
  };
}

interface PgDrizzleExecutor {
  execute(statement: SQL): Promise<{ rows: unknown[] }>;
  transaction<T>(callback: (tx: PgDrizzleExecutor) => Promise<T>): Promise<T>;
}

function postgresExecutor(client: PgDrizzleExecutor, destroy: () => Promise<void> = async () => undefined): SqlExecutor {
  return {
    dialect: "postgres",
    query: async <T extends object>(statement: SQL) => {
      const result = await client.execute(statement);
      return normalizeRows(result.rows as T[]);
    },
    execute: async (statement: SQL) => {
      await client.execute(statement);
    },
    transaction: async <T>(callback: (tx: SqlExecutor) => Promise<T>) =>
      client.transaction(async (tx) => callback(postgresExecutor(tx))),
    destroy,
  };
}
