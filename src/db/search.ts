import { sql } from "drizzle-orm";
import { valueList, type SqlExecutor } from "./sql.js";
import type { DialectName } from "./types.js";

const SNIPPET_MAX_WORDS = 24;

export interface SearchHit {
  id: number;
  snippet: string;
  // sqlite bm25: lower rank is better (ordered asc); pg ts_rank: higher is better (ordered desc).
  // Consumers must treat rank as opaque per dialect and rely on the returned ordering.
  rank: number;
}

export interface TextSearch {
  indexMessage(id: number, threadId: number, text: string): Promise<void>;
  indexChunk(id: number, fileId: number, text: string): Promise<void>;
  indexSummary(id: number, threadId: number, text: string): Promise<void>;
  removeMessage(id: number): Promise<void>;
  removeChunksForFile(fileId: number): Promise<void>;
  searchMessages(threadIds: number[], q: string, limit: number): Promise<SearchHit[]>;
  searchChunks(fileIds: number[], q: string, limit: number): Promise<SearchHit[]>;
  searchSummaries(threadIds: number[], q: string, limit: number): Promise<SearchHit[]>;
}

interface SearchTarget {
  sqliteTable: string;
  pgTable: string;
  idColumn: string;
  scopeColumn: string;
}

const TARGETS = {
  message: { sqliteTable: "messages_fts", pgTable: "message_search", idColumn: "message_id", scopeColumn: "thread_id" },
  chunk: { sqliteTable: "chunks_fts", pgTable: "chunk_search", idColumn: "chunk_id", scopeColumn: "file_id" },
  summary: { sqliteTable: "summaries_fts", pgTable: "summary_search", idColumn: "summary_id", scopeColumn: "thread_id" },
} satisfies Record<string, SearchTarget>;

export function createTextSearch(db: SqlExecutor, dialect: DialectName): TextSearch {
  return dialect === "sqlite" ? new SqliteTextSearch(db) : new PgTextSearch(db);
}

class SqliteTextSearch implements TextSearch {
  constructor(private readonly db: SqlExecutor) {}

  indexMessage(id: number, threadId: number, text: string): Promise<void> {
    return this.index(TARGETS.message, id, threadId, text);
  }

  indexChunk(id: number, fileId: number, text: string): Promise<void> {
    return this.index(TARGETS.chunk, id, fileId, text);
  }

  indexSummary(id: number, threadId: number, text: string): Promise<void> {
    return this.index(TARGETS.summary, id, threadId, text);
  }

  removeMessage(id: number): Promise<void> {
    return this.removeById(TARGETS.message, id);
  }

  removeChunksForFile(fileId: number): Promise<void> {
    return this.removeByScope(TARGETS.chunk, fileId);
  }

  searchMessages(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    return this.search(TARGETS.message, threadIds, q, limit);
  }

  searchChunks(fileIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    return this.search(TARGETS.chunk, fileIds, q, limit);
  }

  searchSummaries(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    return this.search(TARGETS.summary, threadIds, q, limit);
  }

  private async index(target: SearchTarget, id: number, scopeId: number, text: string): Promise<void> {
    const table = sql.raw(target.sqliteTable);
    const idColumn = sql.raw(target.idColumn);
    const scopeColumn = sql.raw(target.scopeColumn);
    await this.db.execute(sql`delete from ${table} where ${idColumn} = ${id}`);
    if (text.trim()) {
      await this.db.execute(sql`insert into ${table}(text, ${idColumn}, ${scopeColumn}) values (${text}, ${id}, ${scopeId})`);
    }
  }

  private async removeById(target: SearchTarget, id: number): Promise<void> {
    const table = sql.raw(target.sqliteTable);
    const idColumn = sql.raw(target.idColumn);
    await this.db.execute(sql`delete from ${table} where ${idColumn} = ${id}`);
  }

  private async removeByScope(target: SearchTarget, scopeId: number): Promise<void> {
    const table = sql.raw(target.sqliteTable);
    const scopeColumn = sql.raw(target.scopeColumn);
    await this.db.execute(sql`delete from ${table} where ${scopeColumn} = ${scopeId}`);
  }

  private search(target: SearchTarget, scopeIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!scopeIds.length) return Promise.resolve([]);
    const query = sqliteQuery(q);
    const table = sql.raw(target.sqliteTable);
    const idColumn = sql.raw(target.idColumn);
    const scopeColumn = sql.raw(target.scopeColumn);
    return this.db.query<SearchHit>(sql`
      select ${idColumn} as id, snippet(${table}, 0, '<b>', '</b>', '...', ${sql.raw(String(SNIPPET_MAX_WORDS))}) as snippet, bm25(${table}) as rank
      from ${table}
      where ${table} match ${query}
        and ${scopeColumn} in (${valueList(scopeIds)})
      order by rank
      limit ${limit}
    `);
  }
}

class PgTextSearch implements TextSearch {
  constructor(private readonly db: SqlExecutor) {}

  indexMessage(id: number, threadId: number, text: string): Promise<void> {
    return this.index(TARGETS.message, id, threadId, text);
  }

  indexChunk(id: number, fileId: number, text: string): Promise<void> {
    return this.index(TARGETS.chunk, id, fileId, text);
  }

  indexSummary(id: number, threadId: number, text: string): Promise<void> {
    return this.index(TARGETS.summary, id, threadId, text);
  }

  removeMessage(id: number): Promise<void> {
    return this.removeById(TARGETS.message, id);
  }

  removeChunksForFile(fileId: number): Promise<void> {
    return this.removeByScope(TARGETS.chunk, fileId);
  }

  searchMessages(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    return this.search(TARGETS.message, threadIds, q, limit);
  }

  searchChunks(fileIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    return this.search(TARGETS.chunk, fileIds, q, limit);
  }

  searchSummaries(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    return this.search(TARGETS.summary, threadIds, q, limit);
  }

  private async index(target: SearchTarget, id: number, scopeId: number, text: string): Promise<void> {
    const table = sql.raw(target.pgTable);
    const idColumn = sql.raw(target.idColumn);
    const scopeColumn = sql.raw(target.scopeColumn);
    await this.db.execute(sql`
      insert into ${table}(${idColumn}, ${scopeColumn}, text, ts)
      values (${id}, ${scopeId}, ${text}, to_tsvector('simple', ${text}))
      on conflict (${idColumn}) do update set
        ${scopeColumn} = excluded.${scopeColumn},
        text = excluded.text,
        ts = excluded.ts
    `);
  }

  private async removeById(target: SearchTarget, id: number): Promise<void> {
    const table = sql.raw(target.pgTable);
    const idColumn = sql.raw(target.idColumn);
    await this.db.execute(sql`delete from ${table} where ${idColumn} = ${id}`);
  }

  private async removeByScope(target: SearchTarget, scopeId: number): Promise<void> {
    const table = sql.raw(target.pgTable);
    const scopeColumn = sql.raw(target.scopeColumn);
    await this.db.execute(sql`delete from ${table} where ${scopeColumn} = ${scopeId}`);
  }

  private search(target: SearchTarget, scopeIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!scopeIds.length) return Promise.resolve([]);
    const table = sql.raw(target.pgTable);
    const idColumn = sql.raw(target.idColumn);
    const scopeColumn = sql.raw(target.scopeColumn);
    const maxWords = sql.raw(`'MaxWords=${SNIPPET_MAX_WORDS}'`);
    return this.db.query<SearchHit>(sql`
      select ${idColumn} as id,
             ts_headline('simple', text, websearch_to_tsquery('simple', ${q}), ${maxWords}) as snippet,
             ts_rank(ts, websearch_to_tsquery('simple', ${q})) as rank
      from ${table}
      where ${scopeColumn} in (${valueList(scopeIds)})
        and ts @@ websearch_to_tsquery('simple', ${q})
      order by rank desc
      limit ${limit}
    `);
  }
}

function sqliteQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((term) => term.trim().replace(/"/g, '""'))
    .filter(Boolean)
    .map((term) => `"${term}"`);
  return terms.length ? terms.join(" OR ") : '""';
}
