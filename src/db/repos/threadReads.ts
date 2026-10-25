import { sql } from "drizzle-orm";
import { asRecord } from "../../util/records.js";
import { messageScopePredicate } from "../search.js";
import { queryOne, valueList, type SqlExecutor } from "../sql.js";
import { messageSearchScopesForChain } from "./messages.js";
import { ThreadsRepo } from "./threads.js";

export interface ThreadReadState {
  readMessageId: number | null;
  lastMessageId: number | null;
  unread: boolean;
}

export class ThreadReadsRepo {
  constructor(private readonly db: SqlExecutor) {}

  async states(userId: number, threadIds: string[]): Promise<Map<string, ThreadReadState>> {
    if (!threadIds.length) return new Map();
    const whitespace = " \t\n\r\v\f";
    const text = this.db.dialect === "sqlite" ? sql`trim(m.text_plain, ${whitespace})` : sql`btrim(m.text_plain, ${whitespace})`;
    const rows = await this.db.query<{
      id: string; readMessageId: number | null; lastMessageId: number | null; unread: number;
      pendingId: number | null; priorMessageId: number | null; turnId: number | null; lease: number | null;
      content: string | null; hasText: number | null; hasFiles: number | null;
    }>(sql`
      with recursive visible_threads(root_id, source_id, max_message_id, depth) as (
        select id, id, cast(null as bigint), 0 from threads
        where user_id = ${userId} and id in (${valueList(threadIds)})
        union all
        select v.root_id, parent.id,
          case when v.max_message_id is null or child.fork_point_message_id < v.max_message_id
            then child.fork_point_message_id else v.max_message_id end, v.depth + 1
        from visible_threads v join threads child on child.id = v.source_id
        join threads parent on parent.id = child.parent_thread_id and parent.user_id = ${userId}
        where child.fork_point_message_id is not null and v.depth < 999
      ), visible_messages as (
        select v.root_id, m.id, m.role, r.id as turn_id, r.lease_expires_at as lease,
          case when r.id is not null then m.content_json end as content,
          case when ${text} <> '' then 1 else 0 end as has_text,
          case when exists (select 1 from files f where f.message_id = m.id) or exists (
            select 1 from message_files mf join files f on f.id = mf.file_id where mf.message_id = m.id
          ) then 1 else 0 end as has_files
        from visible_threads v join messages m on m.thread_id = v.source_id
        left join turn_runs r on r.thread_id = m.thread_id and r.user_id = ${userId}
          and r.status in ('running', 'awaiting_delivery') and m.role = 'assistant'
          and m.id > r.user_message_id and m.content_json like ${'%"attachmentDeliveryTurnId"%'}
        where v.max_message_id is null or m.id <= v.max_message_id
      ), summaries as (
        select t.id, r.message_id as read_message_id, max(m.id) as last_message_id,
          max(case when m.role = 'assistant' and m.turn_id is null
            and m.id > coalesce(r.message_id, 0) and (m.has_text = 1 or m.has_files = 1)
            then 1 else 0 end) as unread
        from threads t left join thread_reads r on r.thread_id = t.id and r.user_id = ${userId}
        left join visible_messages m on m.root_id = t.id
        where t.user_id = ${userId} and t.id in (${valueList(threadIds)})
        group by t.id, r.message_id
      )
      select s.id, s.read_message_id as "readMessageId", s.last_message_id as "lastMessageId", s.unread,
        p.id as "pendingId", p.turn_id as "turnId", p.lease, p.content,
        p.has_text as "hasText", p.has_files as "hasFiles",
        (select max(previous.id) from visible_messages previous
          where previous.root_id = s.id and previous.id < p.id) as "priorMessageId"
      from summaries s left join visible_messages p on p.root_id = s.id and p.turn_id is not null
    `);
    const result = new Map<string, ThreadReadState>();
    const now = Date.now();
    for (const row of rows) {
      const state = result.get(row.id) ?? {
        readMessageId: row.readMessageId, lastMessageId: row.lastMessageId, unread: Boolean(row.unread),
      };
      let pending = false;
      if (row.content !== null) {
        try { pending = asRecord(JSON.parse(row.content))?.attachmentDeliveryTurnId === row.turnId; }
        catch { /* Malformed historical metadata does not hide saved content. */ }
      }
      if (pending) {
        // Lease expiry can reveal recoverable media, but only terminal recovery
        // or finalization makes it safe for the read cursor to pass this row.
        const limit = row.priorMessageId ?? 0;
        state.lastMessageId = Math.min(state.lastMessageId ?? 0, limit) || null;
      }
      if (row.pendingId !== null && row.pendingId > (state.readMessageId ?? 0)) {
        const hidden = pending && row.lease !== null && row.lease > now;
        state.unread ||= Boolean(row.hasText || (!hidden && row.hasFiles));
      }
      result.set(row.id, state);
    }
    return result;
  }

  async markRead(userId: number, threadId: string, messageId: number): Promise<ThreadReadState | undefined> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return undefined;
    return this.db.transaction(async tx => {
      const threads = new ThreadsRepo(tx);
      const thread = await threads.get(threadId);
      if (!thread || thread.user_id !== userId) return undefined;
      const chain = await threads.chain(thread);
      const scopes = messageSearchScopesForChain(chain);
      const visible = await queryOne(tx, sql`
        select id from messages where id = ${messageId}
          and ${messageScopePredicate(sql`thread_id`, sql`id`, chain.map(t => t.id), scopes)}
      `);
      if (!visible) return undefined;
      const reads = new ThreadReadsRepo(tx);
      const state = (await reads.states(userId, [threadId])).get(threadId)!;
      const cursor = Math.min(messageId, state.lastMessageId ?? 0);
      if (cursor > 0) await tx.execute(sql`
        insert into thread_reads(user_id, thread_id, message_id) values (${userId}, ${threadId}, ${cursor})
        on conflict(user_id, thread_id) do update set message_id =
          case when excluded.message_id > thread_reads.message_id then excluded.message_id else thread_reads.message_id end
      `);
      return (await reads.states(userId, [threadId])).get(threadId);
    });
  }

  async markCurrentRead(userId: number, threadId: string): Promise<void> {
    const state = (await this.states(userId, [threadId])).get(threadId);
    if (state && state.lastMessageId !== null) {
      await this.markRead(userId, threadId, state.lastMessageId);
    }
  }
}
