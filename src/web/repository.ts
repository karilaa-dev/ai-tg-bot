import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../db/sql.js";
import { valueList } from "../db/sql.js";
import type { Repos } from "../db/repos/index.js";
import { messageSearchScopesForChain } from "../db/repos/messages.js";
import { messageScopePredicate } from "../db/search.js";
import type { MessageRow, ThreadRow } from "../db/types.js";
import type { WebPage, WebThread, WebUser } from "./types.js";

import { messageView, type SavedAttachment, type SavedTranscript } from "./message-view.js";
import { UsageRepository, type UsageScope } from "./usage.js";
import type { UsagePricing } from "./usage-pricing.js";

export class WebNotFound extends Error {}

export class ConversationRepository {
  private readonly usage: UsageRepository;
  constructor(private readonly db: SqlExecutor, private readonly repos: Repos, private readonly botUserId?: number, pricing?: UsagePricing) {
    this.usage = new UsageRepository(db, botUserId, pricing);
  }

  async usageReport(scope: UsageScope) {
    if (scope.userId !== undefined) await this.user(scope.userId);
    if (scope.threadId !== undefined) {
      const { thread } = await this.scope(scope.threadId);
      if (scope.userId !== undefined && thread.user_id !== scope.userId) throw new WebNotFound();
    }
    return this.usage.report(scope);
  }

  async users(search: string, offset: number, limit = 50): Promise<WebPage<WebUser>> {
    const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    const lower = this.db.dialect === "sqlite" ? sql`unicode_lower` : sql`lower`;
    const messageActivity = sql`max((select max(m.created_at) from messages m where m.thread_id = t.id))`;
    const rows = await this.db.query<WebUser>(sql`
      select u.tg_id as id, u.first_name as name, u.username,
        case when ${messageActivity} > max(t.created_at) then ${messageActivity}
          else coalesce(max(t.created_at), u.created_at) end as "lastActivity",
        count(distinct t.id) as "threadCount"
      from users u left join threads t on t.user_id = u.tg_id
      where ${this.botUserId === undefined ? sql`true` : sql`u.tg_id <> ${this.botUserId}`}
        and (${lower}(coalesce(u.first_name, '')) like ${pattern} escape ${"\\"}
        or ${lower}(coalesce(u.username, '')) like ${pattern} escape ${"\\"}
        or cast(u.tg_id as text) like ${pattern} escape ${"\\"})
      group by u.tg_id, u.first_name, u.username, u.created_at
      order by "lastActivity" desc, u.tg_id desc limit ${limit + 1} offset ${offset}
    `);
    return page(rows.map(row => ({ ...row, threadCount: Number(row.threadCount) })), offset, limit);
  }

  async user(id: number): Promise<WebUser> {
    const user = await this.repos.users.get(id);
    if (!user || id === this.botUserId) throw new WebNotFound();
    return { id: user.tg_id, name: user.first_name, username: user.username, lastActivity: user.created_at, threadCount: 0 };
  }

  async threads(userId: number, offset: number, limit = 50): Promise<WebPage<WebThread>> {
    await this.user(userId);
    const rows = await this.db.query<ThreadRow & { lastActivity: number }>(sql`
      select t.*, coalesce((select max(m.created_at) from messages m where m.thread_id = t.id), t.created_at) as "lastActivity"
      from threads t where t.user_id = ${userId}
      order by "lastActivity" desc, t.id desc limit ${limit + 1} offset ${offset}
    `);
    return page(rows.map(threadView), offset, limit);
  }

  async scope(threadId: number) {
    const thread = await this.repos.threads.get(threadId);
    if (!thread || thread.user_id === this.botUserId) throw new WebNotFound();
    // Bound traversal and require every ancestor to belong to the same user.
    const chain: ThreadRow[] = [thread];
    const seen = new Set([thread.id]);
    let current = thread;
    while (current.parent_thread_id !== null) {
      if (seen.has(current.parent_thread_id) || chain.length >= 1000) throw new Error("Invalid thread ancestry");
      const parent = await this.repos.threads.get(current.parent_thread_id);
      if (!parent || parent.user_id !== thread.user_id || current.fork_point_message_id === null) break;
      seen.add(parent.id);
      chain.push(parent);
      current = parent;
    }
    chain.reverse();
    const scopes = messageSearchScopesForChain(chain);
    // A later fork can point into inherited history: apply its bound to all earlier ancestors.
    let ceiling: number | undefined;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const own = scopes[i]!.maxMessageId;
      if (own !== undefined) ceiling = Math.min(ceiling ?? own, own);
      if (ceiling !== undefined) scopes[i]!.maxMessageId = ceiling;
    }
    return { thread, chain, scopes };
  }

  async history(threadId: number, before?: number, after?: number) {
    const { thread, chain, scopes } = await this.scope(threadId);
    const rows = await this.db.query<MessageRow>(sql`
      select * from messages where ${messageScopePredicate(sql`thread_id`, sql`id`, chain.map(t => t.id), scopes)}
      ${before === undefined ? sql`` : sql`and id < ${before}`}
      ${after === undefined ? sql`` : sql`and id >= ${after}`}
      order by id ${after === undefined ? sql`desc` : sql`asc`} limit 51
    `);
    const hasMore = rows.length > 50;
    const selected = rows.slice(0, 50);
    if (after === undefined) selected.reverse();
    const attachments = await this.attachments(selected.map(m => m.id));
    const transcripts = selected.some(m => m.text_plain.includes("[Audio transcript preview;"))
      ? await this.savedTranscripts(selected.map(m => m.id)) : [];
    const messages = selected.map(m => messageView(m, attachments.get(m.id) ?? [], transcripts));
    const usage = await this.usage.messages(selected.filter(m => m.role === "assistant").map(m => m.id));
    for (const message of messages) if (message.role === "assistant") message.usage = usage.get(message.id) ?? null;
    return {
      user: await this.user(thread.user_id), thread: threadView(thread),
      chain: chain.map(t => ({ id: t.id, title: t.title, parentThreadId: t.parent_thread_id, forkPointMessageId: t.fork_point_message_id })),
      messages,
      olderCursor: after === undefined && hasMore ? selected[0]!.id : null,
      newerCursor: after !== undefined && hasMore ? selected.at(-1)!.id + 1 : null,
    };
  }

  private async attachments(messageIds: number[]): Promise<Map<number, SavedAttachment[]>> {
    const result = new Map<number, SavedAttachment[]>();
    if (!messageIds.length) return result;
    const rows = await this.db.query<SavedAttachment & { messageId: number }>(sql`
      select m.id as "messageId", f.id, coalesce(mf.display_name, f.name) as name,
        f.size, f.mime_type as "mimeType", mf.caption,
        case when f.is_inline = 1 then f.content_md else null end as "inlineContent",
        case when f.type in ('image', 'audio') then f.type else 'file' end as kind,
        case when f.type = 'image' then f.summary else null end as description
      from messages m join files f on f.message_id = m.id or exists (
        select 1 from message_files link where link.file_id = f.id and link.message_id = m.id
      )
      left join message_files mf on mf.file_id = f.id and mf.message_id = m.id
      where m.id in (${valueList(messageIds)}) order by m.id, f.id
    `);
    for (const { messageId, ...file } of rows) {
      const files = result.get(messageId) ?? [];
      files.push({ ...file, size: file.size !== null && file.size > 0 ? file.size : null });
      result.set(messageId, files);
    }
    return result;
  }

  private savedTranscripts(messageIds: number[]): Promise<SavedTranscript[]> {
    return this.db.query<SavedTranscript>(sql`
      select a.id, a.source_file_id as "fileId", m.id as "messageId", a.text
      from audio_transcripts a
      left join turn_run_sources s on s.telegram_update_id = a.telegram_update_id
      left join turn_runs r on r.id = s.turn_run_id
      join messages m on m.id = coalesce(a.source_message_id, r.user_message_id)
      join threads t on t.id = m.thread_id
      where m.id in (${valueList(messageIds)}) and a.thread_id = m.thread_id and a.user_id = t.user_id
    `);
  }

  async file(threadId: number, fileId: number) {
    const { chain, scopes } = await this.scope(threadId);
    const rows = await this.db.query<{ id: number }>(sql`
      select f.id from files f join messages m on f.message_id = m.id or exists (
        select 1 from message_files mf where mf.file_id = f.id and mf.message_id = m.id
      ) where f.id = ${fileId}
      and ${messageScopePredicate(sql`m.thread_id`, sql`m.id`, chain.map(t => t.id), scopes)} limit 1
    `);
    if (!rows.length) throw new WebNotFound();
    const file = await this.repos.files.get(fileId);
    if (!file) throw new WebNotFound();
    return file;
  }
}

function threadView(t: ThreadRow & { lastActivity?: number }): WebThread {
  return { id: t.id, userId: t.user_id, title: t.title, archived: Boolean(t.archived),
    parentThreadId: t.parent_thread_id, forkPointMessageId: t.fork_point_message_id,
    lastActivity: t.lastActivity ?? t.created_at };
}

function page<T>(rows: T[], offset: number, limit: number): WebPage<T> {
  return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}
