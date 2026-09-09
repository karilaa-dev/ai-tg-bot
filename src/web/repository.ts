import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../db/sql.js";
import { valueList } from "../db/sql.js";
import type { Repos } from "../db/repos/index.js";
import { messageSearchScopesForChain } from "../db/repos/messages.js";
import { messageScopePredicate } from "../db/search.js";
import type { MessageRow, ThreadRow } from "../db/types.js";
import type { WebAttachment, WebMessage, WebPage, WebThread, WebUser } from "./types.js";

export class WebNotFound extends Error {}

export class ConversationRepository {
  constructor(private readonly db: SqlExecutor, private readonly repos: Repos) {}

  async users(search: string, offset: number, limit = 50): Promise<WebPage<WebUser>> {
    const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await this.db.query<WebUser>(sql`
      select u.tg_id as id, u.first_name as name, u.username,
        coalesce(max(m.created_at), max(t.created_at), u.created_at) as "lastActivity",
        count(distinct t.id) as "threadCount"
      from users u left join threads t on t.user_id = u.tg_id
      left join messages m on m.thread_id = t.id
      where lower(coalesce(u.first_name, '')) like ${pattern} escape ${"\\"}
        or lower(coalesce(u.username, '')) like ${pattern} escape ${"\\"}
        or cast(u.tg_id as text) like ${pattern} escape ${"\\"}
      group by u.tg_id, u.first_name, u.username, u.created_at
      order by "lastActivity" desc, u.tg_id desc limit ${limit + 1} offset ${offset}
    `);
    return page(rows.map(row => ({ ...row, threadCount: Number(row.threadCount) })), offset, limit);
  }

  async user(id: number): Promise<WebUser> {
    const user = await this.repos.users.get(id);
    if (!user) throw new WebNotFound();
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
    if (!thread) throw new WebNotFound();
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
    const messages: WebMessage[] = selected.map(m => ({
      id: m.id, threadId: m.thread_id, role: m.role, text: m.text_plain,
      thinking: m.thinking, createdAt: m.created_at, attachments: attachments.get(m.id) ?? [],
    }));
    return {
      user: await this.user(thread.user_id), thread: threadView(thread),
      chain: chain.map(t => ({ id: t.id, title: t.title, parentThreadId: t.parent_thread_id, forkPointMessageId: t.fork_point_message_id })),
      messages,
      olderCursor: after === undefined && hasMore ? selected[0]!.id : null,
      newerCursor: after !== undefined && hasMore ? selected.at(-1)!.id + 1 : null,
    };
  }

  private async attachments(messageIds: number[]): Promise<Map<number, WebAttachment[]>> {
    const result = new Map<number, WebAttachment[]>();
    if (!messageIds.length) return result;
    const rows = await this.db.query<WebAttachment & { messageId: number }>(sql`
      select m.id as "messageId", f.id, coalesce(mf.display_name, f.name) as name,
        f.size, f.mime_type as "mimeType", mf.caption
      from messages m join files f on f.message_id = m.id or exists (
        select 1 from message_files link where link.file_id = f.id and link.message_id = m.id
      )
      left join message_files mf on mf.file_id = f.id and mf.message_id = m.id
      where m.id in (${valueList(messageIds)}) order by m.id, f.id
    `);
    for (const { messageId, ...file } of rows) {
      const files = result.get(messageId) ?? [];
      files.push({ ...file, size: file.size !== null && file.size >= 0 ? file.size : null });
      result.set(messageId, files);
    }
    return result;
  }

  async file(threadId: number, fileId: number) {
    const { thread, chain, scopes } = await this.scope(threadId);
    const rows = await this.db.query<{ id: number }>(sql`
      select f.id from files f join messages m on f.message_id = m.id or exists (
        select 1 from message_files mf where mf.file_id = f.id and mf.message_id = m.id
      ) where f.id = ${fileId} and f.user_id = ${thread.user_id}
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
