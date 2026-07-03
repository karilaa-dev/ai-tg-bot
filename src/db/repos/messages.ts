import { sql, type SQL } from "drizzle-orm";
import { insertReturning, queryOne, valueList, type SqlExecutor } from "../sql.js";
import type { TextSearch } from "../search.js";
import type { MessageKind, MessageRole, MessageRow, ThreadRow } from "../types.js";

const MESSAGE_SNIPPET_MAX_CHARS = 240;

export class MessagesRepo {
  constructor(
    private readonly db: SqlExecutor,
    private readonly search: TextSearch,
  ) {}

  async insert(input: {
    threadId: number;
    role: MessageRole;
    kind?: MessageKind;
    content: unknown;
    textPlain: string;
    thinking?: string | null;
    tgMessageId?: number | null;
    tokensEst?: number | null;
  }): Promise<MessageRow> {
    const inserted = await insertReturning<MessageRow>(
      this.db,
      sql`
        insert into messages(thread_id, role, kind, content_json, text_plain, thinking, tg_message_id, tokens_est, created_at)
        values (
          ${input.threadId},
          ${input.role},
          ${input.kind ?? "text"},
          ${JSON.stringify(input.content)},
          ${input.textPlain},
          ${input.thinking ?? null},
          ${input.tgMessageId ?? null},
          ${input.tokensEst ?? null},
          ${Date.now()}
        )
        returning *
      `,
    );
    await this.search.indexMessage(inserted.id, inserted.thread_id, inserted.text_plain);
    return inserted;
  }

  listThread(threadId: number): Promise<MessageRow[]> {
    return this.db.query<MessageRow>(sql`select * from messages where thread_id = ${threadId} order by id asc`);
  }

  async listForThreadChain(threads: ThreadRow[]): Promise<MessageRow[]> {
    return this.listForThreadChainRows(threads, { excludeCompacted: true });
  }

  async listForThreadChainSearchScope(threads: ThreadRow[]): Promise<MessageRow[]> {
    return this.listForThreadChainRows(threads, { excludeCompacted: false });
  }

  private async listForThreadChainRows(
    threads: ThreadRow[],
    options: { excludeCompacted: boolean },
  ): Promise<MessageRow[]> {
    const rows: MessageRow[] = [];
    for (let i = 0; i < threads.length; i += 1) {
      const thread = threads[i]!;
      const child = threads[i + 1];
      const filters: SQL[] = [sql`thread_id = ${thread.id}`];
      if (child?.parent_thread_id === thread.id && child.fork_point_message_id !== null) {
        filters.push(sql`id <= ${child.fork_point_message_id}`);
      }
      if (options.excludeCompacted && thread.compacted_upto_message_id !== null) {
        filters.push(sql`id > ${thread.compacted_upto_message_id}`);
      }
      rows.push(...(await this.db.query<MessageRow>(sql`select * from messages where ${sql.join(filters, sql` and `)} order by id asc`)));
    }
    return rows.sort((a, b) => a.id - b.id);
  }

  async idsForThreads(threadIds: number[]): Promise<number[]> {
    if (!threadIds.length) return [];
    const rows = await this.db.query<{ id: number }>(sql`select id from messages where thread_id in (${valueList(threadIds)})`);
    return rows.map((row) => row.id);
  }

  async snippets(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db.query<{ id: number; text_plain: string }>(sql`select id, text_plain from messages where id in (${valueList(ids)})`);
    return new Map(rows.map((row) => [row.id, row.text_plain.slice(0, MESSAGE_SNIPPET_MAX_CHARS)]));
  }

  latest(threadId: number): Promise<MessageRow | undefined> {
    return queryOne<MessageRow>(this.db, sql`select * from messages where thread_id = ${threadId} order by id desc limit 1`);
  }

  get(id: number): Promise<MessageRow | undefined> {
    return queryOne<MessageRow>(this.db, sql`select * from messages where id = ${id}`);
  }
}
