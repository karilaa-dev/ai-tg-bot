import { sql, type SQL } from "drizzle-orm";
import { insertReturning, queryOne, type SqlExecutor } from "../sql.js";
import { createTextSearch, type MessageSearchScope } from "../search.js";
import type { MessageKind, MessageRole, MessageRow, ThreadRow } from "../types.js";

export class MessagesRepo {
  constructor(private readonly db: SqlExecutor) {}

  async insert(input: {
    threadId: number;
    role: MessageRole;
    kind?: MessageKind;
    content: unknown;
    textPlain: string;
    thinking?: string | null;
    tgMessageId?: number | null;
    piEntryId?: string | null;
  }): Promise<MessageRow> {
    return this.db.transaction(async (tx) => {
      const inserted = await insertReturning<MessageRow>(
        tx,
        sql`
          insert into messages(thread_id, role, kind, content_json, text_plain, thinking, tg_message_id, pi_entry_id, created_at)
          values (
            ${input.threadId},
            ${input.role},
            ${input.kind ?? "text"},
            ${JSON.stringify(input.content)},
            ${input.textPlain},
            ${input.thinking ?? null},
            ${input.tgMessageId ?? null},
            ${input.piEntryId ?? null},
            ${Date.now()}
          )
          returning *
        `,
      );
      await createTextSearch(tx, tx.dialect).indexMessage(
        inserted.id,
        inserted.thread_id,
        inserted.text_plain,
      );
      return inserted;
    });
  }

  async setPiEntryId(messageId: number, entryId: string): Promise<void> {
    await this.db.execute(sql`update messages set pi_entry_id = ${entryId} where id = ${messageId}`);
  }

  async setDeliveryContent(input: {
    messageId: number;
    content: unknown;
    textPlain: string;
    tgMessageId: number | null;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const message = await queryOne<MessageRow>(tx, sql`select * from messages where id = ${input.messageId}`);
      if (!message) throw new Error(`Message #${input.messageId} no longer exists.`);
      await tx.execute(sql`
        update messages
        set content_json = ${JSON.stringify(input.content)},
            text_plain = ${input.textPlain},
            tg_message_id = ${input.tgMessageId}
        where id = ${input.messageId}
      `);
      await createTextSearch(tx, tx.dialect).indexMessage(message.id, message.thread_id, input.textPlain);
    });
  }

  async setThinking(messageId: number, thinking: string, tgMessageId?: number): Promise<void> {
    await this.db.execute(sql`
      update messages
      set thinking = ${thinking},
          tg_message_id = coalesce(tg_message_id, ${tgMessageId ?? null})
      where id = ${messageId}
    `);
  }

  listThread(threadId: number): Promise<MessageRow[]> {
    return this.db.query<MessageRow>(sql`select * from messages where thread_id = ${threadId} order by id asc`);
  }

  async listForThreadChain(threads: ThreadRow[]): Promise<MessageRow[]> {
    return this.listForThreadChainRows(threads);
  }

  async listForThreadChainSearchScope(threads: ThreadRow[], maxMessageId?: number): Promise<MessageRow[]> {
    return this.listForThreadChainRows(threads, maxMessageId);
  }

  private async listForThreadChainRows(
    threads: ThreadRow[],
    maxMessageId?: number,
  ): Promise<MessageRow[]> {
    const rows: MessageRow[] = [];
    for (let i = 0; i < threads.length; i += 1) {
      const thread = threads[i]!;
      const child = threads[i + 1];
      const filters: SQL[] = [sql`thread_id = ${thread.id}`];
      if (maxMessageId !== undefined) filters.push(sql`id <= ${maxMessageId}`);
      if (child?.parent_thread_id === thread.id && child.fork_point_message_id !== null) {
        filters.push(sql`id <= ${child.fork_point_message_id}`);
      }
      rows.push(...(await this.db.query<MessageRow>(sql`select * from messages where ${sql.join(filters, sql` and `)} order by id asc`)));
    }
    return rows.sort((a, b) => a.id - b.id);
  }

  latest(threadId: number): Promise<MessageRow | undefined> {
    return queryOne<MessageRow>(this.db, sql`select * from messages where thread_id = ${threadId} order by id desc limit 1`);
  }

  get(id: number): Promise<MessageRow | undefined> {
    return queryOne<MessageRow>(this.db, sql`select * from messages where id = ${id}`);
  }
}

export function messageSearchScopesForChain(
  threads: ThreadRow[],
  maxMessageId?: number,
): MessageSearchScope[] {
  return threads.map((thread, index) => {
    const child = threads[index + 1];
    const bounds = [
      maxMessageId,
      child?.parent_thread_id === thread.id ? child.fork_point_message_id ?? undefined : undefined,
    ].filter((value): value is number => value !== undefined);
    return {
      threadId: thread.id,
      ...(bounds.length ? { maxMessageId: Math.min(...bounds) } : {}),
    };
  });
}
