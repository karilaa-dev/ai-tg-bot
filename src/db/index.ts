import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type SQL } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqlite } from "drizzle-orm/node-sqlite";
import pg from "pg";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { up } from "./migrations/0001_init.js";
import { createTextSearch, type TextSearch } from "./search.js";
import { normalizeRows, type SqlExecutor } from "./sql.js";
import type { DialectName } from "./types.js";

export interface AppDatabase {
  db: SqlExecutor;
  dialect: DialectName;
  search: TextSearch;
  migrate(): Promise<void>;
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
    const sqlite = drizzleSqlite({ client: new DatabaseSync(sqlitePath) });
    db = {
      dialect,
      query: async <T extends object>(statement: SQL) => normalizeRows(sqlite.all<T>(statement)),
      execute: async (statement: SQL) => {
        sqlite.run(statement);
      },
      destroy: async () => {
        logger?.debug("closing sqlite database");
        sqlite.$client.close();
      },
    };
  } else {
    pg.types.setTypeParser(20, (value) => Number(value));
    logger?.debug("opening postgres database");
    const postgres = drizzlePg(config.DB_URL);
    db = {
      dialect,
      query: async <T extends object>(statement: SQL) => {
        const result = await postgres.execute<Record<string, unknown>>(statement);
        return normalizeRows(result.rows as T[]);
      },
      execute: async (statement: SQL) => {
        await postgres.execute(statement);
      },
      destroy: async () => {
        logger?.debug("closing postgres database");
        await postgres.$client.end();
      },
    };
  }

  return {
    db,
    dialect,
    search: createTextSearch(db, dialect),
    migrate: async () => {
      logger?.debug("migration starting", { dialect });
      await up(db, dialect);
      logger?.info("migrated", { dialect });
    },
    destroy: async () => {
      logger?.debug("database destroy starting", { dialect });
      await db.destroy();
      logger?.debug("database destroy complete", { dialect });
    },
  };
}
