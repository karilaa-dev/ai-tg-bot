import { sql } from "drizzle-orm";
import { valueList, type SqlExecutor } from "./sql.js";
import type { DialectName } from "./types.js";

export interface SearchHit {
  id: number;
  snippet: string;
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

export function createTextSearch(db: SqlExecutor, dialect: DialectName): TextSearch {
  return dialect === "sqlite" ? new SqliteTextSearch(db) : new PgTextSearch(db);
}

class SqliteTextSearch implements TextSearch {
  constructor(private readonly db: SqlExecutor) {}

  async indexMessage(id: number, threadId: number, text: string): Promise<void> {
    await this.db.execute(sql`delete from messages_fts where message_id = ${id}`);
    if (text.trim()) {
      await this.db.execute(sql`insert into messages_fts(text, message_id, thread_id) values (${text}, ${id}, ${threadId})`);
    }
  }

  async indexChunk(id: number, fileId: number, text: string): Promise<void> {
    await this.db.execute(sql`delete from chunks_fts where chunk_id = ${id}`);
    if (text.trim()) {
      await this.db.execute(sql`insert into chunks_fts(text, chunk_id, file_id) values (${text}, ${id}, ${fileId})`);
    }
  }

  async indexSummary(id: number, threadId: number, text: string): Promise<void> {
    await this.db.execute(sql`delete from summaries_fts where summary_id = ${id}`);
    if (text.trim()) {
      await this.db.execute(sql`insert into summaries_fts(text, summary_id, thread_id) values (${text}, ${id}, ${threadId})`);
    }
  }

  async removeMessage(id: number): Promise<void> {
    await this.db.execute(sql`delete from messages_fts where message_id = ${id}`);
  }

  async removeChunksForFile(fileId: number): Promise<void> {
    await this.db.execute(sql`delete from chunks_fts where file_id = ${fileId}`);
  }

  async searchMessages(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!threadIds.length) return [];
    const query = sqliteQuery(q);
    return this.db.query<SearchHit>(sql`
      select message_id as id, snippet(messages_fts, 0, '<b>', '</b>', '...', 24) as snippet, bm25(messages_fts) as rank
      from messages_fts
      where messages_fts match ${query}
        and thread_id in (${valueList(threadIds)})
      order by rank
      limit ${limit}
    `);
  }

  async searchChunks(fileIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!fileIds.length) return [];
    const query = sqliteQuery(q);
    return this.db.query<SearchHit>(sql`
      select chunk_id as id, snippet(chunks_fts, 0, '<b>', '</b>', '...', 24) as snippet, bm25(chunks_fts) as rank
      from chunks_fts
      where chunks_fts match ${query}
        and file_id in (${valueList(fileIds)})
      order by rank
      limit ${limit}
    `);
  }

  async searchSummaries(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!threadIds.length) return [];
    const query = sqliteQuery(q);
    return this.db.query<SearchHit>(sql`
      select summary_id as id, snippet(summaries_fts, 0, '<b>', '</b>', '...', 24) as snippet, bm25(summaries_fts) as rank
      from summaries_fts
      where summaries_fts match ${query}
        and thread_id in (${valueList(threadIds)})
      order by rank
      limit ${limit}
    `);
  }
}

class PgTextSearch implements TextSearch {
  constructor(private readonly db: SqlExecutor) {}

  async indexMessage(id: number, threadId: number, text: string): Promise<void> {
    await this.db.execute(sql`
      insert into message_search(message_id, thread_id, text, ts)
      values (${id}, ${threadId}, ${text}, to_tsvector('simple', ${text}))
      on conflict (message_id) do update set
        thread_id = excluded.thread_id,
        text = excluded.text,
        ts = excluded.ts
    `);
  }

  async indexChunk(id: number, fileId: number, text: string): Promise<void> {
    await this.db.execute(sql`
      insert into chunk_search(chunk_id, file_id, text, ts)
      values (${id}, ${fileId}, ${text}, to_tsvector('simple', ${text}))
      on conflict (chunk_id) do update set
        file_id = excluded.file_id,
        text = excluded.text,
        ts = excluded.ts
    `);
  }

  async indexSummary(id: number, threadId: number, text: string): Promise<void> {
    await this.db.execute(sql`
      insert into summary_search(summary_id, thread_id, text, ts)
      values (${id}, ${threadId}, ${text}, to_tsvector('simple', ${text}))
      on conflict (summary_id) do update set
        thread_id = excluded.thread_id,
        text = excluded.text,
        ts = excluded.ts
    `);
  }

  async removeMessage(id: number): Promise<void> {
    await this.db.execute(sql`delete from message_search where message_id = ${id}`);
  }

  async removeChunksForFile(fileId: number): Promise<void> {
    await this.db.execute(sql`delete from chunk_search where file_id = ${fileId}`);
  }

  async searchMessages(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!threadIds.length) return [];
    return this.db.query<SearchHit>(sql`
      select message_id as id,
             ts_headline('simple', text, websearch_to_tsquery('simple', ${q}), 'MaxWords=24') as snippet,
             ts_rank(ts, websearch_to_tsquery('simple', ${q})) as rank
      from message_search
      where thread_id in (${valueList(threadIds)})
        and ts @@ websearch_to_tsquery('simple', ${q})
      order by rank desc
      limit ${limit}
    `);
  }

  async searchChunks(fileIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!fileIds.length) return [];
    return this.db.query<SearchHit>(sql`
      select chunk_id as id,
             ts_headline('simple', text, websearch_to_tsquery('simple', ${q}), 'MaxWords=24') as snippet,
             ts_rank(ts, websearch_to_tsquery('simple', ${q})) as rank
      from chunk_search
      where file_id in (${valueList(fileIds)})
        and ts @@ websearch_to_tsquery('simple', ${q})
      order by rank desc
      limit ${limit}
    `);
  }

  async searchSummaries(threadIds: number[], q: string, limit: number): Promise<SearchHit[]> {
    if (!threadIds.length) return [];
    return this.db.query<SearchHit>(sql`
      select summary_id as id,
             ts_headline('simple', text, websearch_to_tsquery('simple', ${q}), 'MaxWords=24') as snippet,
             ts_rank(ts, websearch_to_tsquery('simple', ${q})) as rank
      from summary_search
      where thread_id in (${valueList(threadIds)})
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
