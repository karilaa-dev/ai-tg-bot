import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../db/sql.js";
import { valueList } from "../db/sql.js";
import type { Repos } from "../db/repos/index.js";
import { messageSearchScopesForChain } from "../db/repos/messages.js";
import { messageScopePredicate, type MessageSearchScope } from "../db/search.js";
import type { MessageRow, ThreadRow } from "../db/types.js";
import type { WebThread, WebThreadActivity, WebUser, WebPage } from "./types.js";
import type { ChatThread } from "./chat-types.js";

import { attachmentDeliveryTurnId, messageView, type SavedAttachment, type SavedTranscript } from "./message-view.js";
import { UsageRepository, type UsageScope } from "./usage.js";
import type { UsagePricing } from "./usage-pricing.js";
import { refreshPostgresUserSearch } from "../db/userSearch.js";
import { readUserMemories } from "../memory/view.js";
import type { WebMemories } from "./types.js";

export class WebNotFound extends Error {}

export class ConversationRepository {
  private readonly usage: UsageRepository;
  constructor(private readonly db: SqlExecutor, private readonly repos: Repos, private readonly botUserId?: number, pricing?: UsagePricing) {
    this.usage = new UsageRepository(db, botUserId, pricing);
  }

  async usageReport(scope: UsageScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const user = scope.userId !== undefined ? await this.user(scope.userId) : null;
    if (scope.threadId !== undefined) {
      const { thread } = await this.scope(scope.threadId);
      if (scope.userId !== undefined && thread.user_id !== scope.userId) throw new WebNotFound();
    }
    return { ...await this.usage.report(scope, Date.now(), signal),
      user: user ? { id: user.id, name: user.name, username: user.username } : null };
  }

  async users(search: string, offset: number, limit = 50): Promise<WebPage<WebUser>> {
    const visibleUser = this.botUserId === undefined ? sql`true` : sql`u.tg_id <> ${this.botUserId}`;
    let matches = sql`true`;
    if (search) {
      if (this.db.dialect === "postgres") await refreshPostgresUserSearch(this.db);
      const normalized = search.toLowerCase();
      const pattern = `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
      const name = this.db.dialect === "postgres" ? sql`u.first_name_search` : sql`unicode_lower(coalesce(u.first_name, ''))`;
      const username = this.db.dialect === "postgres" ? sql`u.username_search` : sql`unicode_lower(coalesce(u.username, ''))`;
      matches = sql`${name} like ${pattern} escape ${"\\"}
        or ${username} like ${pattern} escape ${"\\"}
        or cast(u.tg_id as text) like ${pattern} escape ${"\\"}`;
    }
    const messageActivity = sql`max((select max(m.created_at) from messages m where m.thread_id = t.id))`;
    const rows = await this.db.query<WebUser>(sql`
      select u.tg_id as id, u.first_name as name, u.username,
        case when ${messageActivity} > max(t.created_at) then ${messageActivity}
          else coalesce(max(t.created_at), u.created_at) end as "lastActivity",
        count(distinct t.id) as "threadCount"
      from users u left join threads t on t.user_id = u.tg_id
      where ${visibleUser} and (${matches})
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

  async memories(userId: number, offset: number): Promise<WebMemories> {
    const user = await this.user(userId);
    const owner = await this.repos.users.get(userId);
    return { ...await readUserMemories(this.db, userId, offset, 50), user, enabled: owner?.memory_enabled === 1 };
  }

  async threads(userId: number, offset: number, limit = 50, search = ""): Promise<WebPage<ChatThread>> {
    await this.user(userId);
    const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    const lower = (value: ReturnType<typeof sql>) => this.db.dialect === "sqlite" ? sql`unicode_lower(${value})` : sql`lower(${value})`;
    const ancestry = search ? sql`with recursive visible_threads(root_id, source_id, max_message_id, depth) as (
      select id, id, cast(null as bigint), 0 from threads where user_id = ${userId}
      union all
      select v.root_id, parent.id,
        case when v.max_message_id is null or child.fork_point_message_id < v.max_message_id
          then child.fork_point_message_id else v.max_message_id end,
        v.depth + 1
      from visible_threads v join threads child on child.id = v.source_id
      join threads parent on parent.id = child.parent_thread_id and parent.user_id = ${userId}
      where child.fork_point_message_id is not null and v.depth < 999
    )` : sql``;
    const matches = search ? sql`and (${lower(sql`t.title`)} like ${pattern} escape ${"\\"}
      or exists (select 1 from visible_threads v join messages m on m.thread_id = v.source_id
        where v.root_id = t.id and (v.max_message_id is null or m.id <= v.max_message_id)
        and m.role in ('user', 'assistant') and ${lower(sql`m.text_plain`)} like ${pattern} escape ${"\\"}))` : sql``;
    const matchId = search ? sql`(select m.id from visible_threads v join messages m on m.thread_id = v.source_id
      where v.root_id = t.id and (v.max_message_id is null or m.id <= v.max_message_id)
        and m.role in ('user', 'assistant') and ${lower(sql`m.text_plain`)} like ${pattern} escape ${"\\"}
      order by m.id desc limit 1)` : sql`null`;
    const rows = await this.db.query<ThreadRow & { lastActivity: number; searchMessageId: number | null }>(sql`
      ${ancestry}
      select t.*, ${matchId} as "searchMessageId", coalesce((select max(m.created_at) from messages m where m.thread_id = t.id), t.created_at) as "lastActivity"
      from threads t where t.user_id = ${userId} ${matches}
      order by "lastActivity" desc, t.id desc limit ${limit + 1} offset ${offset}
    `);
    const matchIds = rows.slice(0, limit).flatMap(row => row.searchMessageId === null ? [] : [row.searchMessageId]);
    const position = this.db.dialect === "sqlite" ? sql`instr(${lower(sql`text_plain`)}, ${search.toLowerCase()})`
      : sql`strpos(${lower(sql`text_plain`)}, ${search.toLowerCase()})`;
    const snippets = matchIds.length ? await this.db.query<{ id: number; text: string; position: number }>(sql`
      select id, ${position} as position,
        substr(text_plain, case when ${position} > 80 then ${position} - 80 else 1 end, 360) as text
      from messages where id in (${valueList(matchIds)})
    `) : [];
    const matchesById = new Map(snippets.map(row => [row.id, {
      messageId: row.id, text: `${row.position > 80 ? "…" : ""}${row.text.replace(/\s+/g, " ")}${row.text.length === 360 ? "…" : ""}`,
    }]));
    const activities = await this.threadActivities(rows.map(row => row.id));
    const reads = await this.repos.threadReads.states(userId, rows.map(row => row.id));
    return page(rows.map(row => ({ ...threadView(row, activities.get(row.id)),
      origin: row.origin, topicId: row.topic_id,
      searchMatch: row.searchMessageId === null ? null : matchesById.get(row.searchMessageId) ?? null,
      unread: reads.get(row.id)?.unread ?? false, lastMessageId: reads.get(row.id)?.lastMessageId ?? null,
    })), offset, limit);
  }

  async scope(threadId: string) {
    const thread = await this.repos.threads.get(threadId);
    if (!thread || thread.user_id === this.botUserId) throw new WebNotFound();
    const chain = await this.repos.threads.chain(thread);
    const scopes = messageSearchScopesForChain(chain);
    return { thread, chain, scopes };
  }

  async history(threadId: string, before?: number, after?: number) {
    const { thread, chain, scopes } = await this.scope(threadId);
    // Capture the acknowledgement bound before rendering. A delivery that
    // completes during projection must be acknowledged on a subsequent read.
    const reads = (await this.repos.threadReads.states(thread.user_id, [threadId])).get(threadId);
    const rows = await this.db.query<MessageRow>(sql`
      select * from messages where ${messageScopePredicate(sql`thread_id`, sql`id`, chain.map(t => t.id), scopes)}
      ${before === undefined ? sql`` : sql`and id < ${before}`}
      ${after === undefined ? sql`` : sql`and id >= ${after}`}
      order by id ${after === undefined ? sql`desc` : sql`asc`} limit 51
    `);
    const hasMore = rows.length > 50;
    const selected = rows.slice(0, 50);
    if (after === undefined) selected.reverse();
    const attachments = await this.attachments(selected.map(m => m.id), scopes);
    const transcripts = selected.some(m => m.text_plain.includes("[Audio transcript preview;"))
      ? await this.savedTranscripts(selected.map(m => m.id)) : [];
    const pendingTurnIds = selected.flatMap(m => attachmentDeliveryTurnId(m) ?? []);
    const delivering = pendingTurnIds.length ? await this.db.query<{ id: number; thread_id: string }>(sql`
      select id, thread_id from turn_runs where id in (${valueList(pendingTurnIds)})
        and status in ('running', 'awaiting_delivery') and lease_expires_at > ${Date.now()}
    `) : [];
    const messages = selected.map(m => messageView(m, attachments.get(m.id) ?? [], transcripts,
      delivering.some(run => run.id === attachmentDeliveryTurnId(m) && run.thread_id === m.thread_id)));
    const replyIds = selected.filter(m => m.role === "assistant").map(m => m.id);
    const usage = await this.usage.messages(replyIds);
    const durations = await this.replyDurations(replyIds);
    for (const message of messages) if (message.role === "assistant") {
      message.usage = usage.get(message.id) ?? null;
      const startedAt = durations.get(message.id);
      if (startedAt !== undefined && message.createdAt >= startedAt) message.durationMs = message.createdAt - startedAt;
    }
    const activities = await this.threadActivities([threadId]);
    const lastMessageId = selected.findLast(message => message.id <= (reads?.lastMessageId ?? 0))?.id ?? null;
    return {
      user: await this.user(thread.user_id), thread: { ...threadView(thread, activities.get(threadId)),
        origin: thread.origin, topicId: thread.topic_id, unread: reads?.unread ?? false, lastMessageId },
      chain: chain.map(t => ({ id: t.id, title: t.title, parentThreadId: t.parent_thread_id, forkPointMessageId: t.fork_point_message_id })),
      messages,
      olderCursor: after === undefined && hasMore ? selected[0]!.id : null,
      newerCursor: after !== undefined && hasMore ? selected.at(-1)!.id + 1 : null,
    };
  }

  /** Start times of the turns that produced these replies, keyed by reply message ID. */
  private async replyDurations(messageIds: number[]): Promise<Map<number, number>> {
    if (!messageIds.length) return new Map();
    const rows = await this.db.query<{ id: number; started: number }>(sql`
      select result_message_id as id, min(started_at) as started from turn_runs
      where result_message_id in (${valueList(messageIds)}) and started_at is not null
      group by result_message_id
    `);
    return new Map(rows.map(row => [Number(row.id), Number(row.started)]));
  }

  private async threadActivities(threadIds: string[]): Promise<Map<string, WebThreadActivity>> {
    if (!threadIds.length) return new Map();
    const rows = await this.db.query<{
      id: string; queued: number; status: string | null; cancelled: number | null; lease: number | null; started: number | null;
    }>(sql`
      select r.thread_id as id,
        sum(case when r.status = 'queued' then 1 else 0 end) as queued,
        max(case when r.status <> 'queued' then r.status end) as status,
        max(case when r.status <> 'queued' then r.cancel_requested_at end) as cancelled,
        max(case when r.status <> 'queued' then r.lease_expires_at end) as lease,
        max(case when r.status <> 'queued' then r.started_at end) as started
      from turn_runs r join threads t on t.id = r.thread_id and t.user_id = r.user_id
      where r.thread_id in (${valueList(threadIds)}) and r.status in ('queued', 'running', 'awaiting_delivery')
      group by r.thread_id
    `);
    const now = Date.now();
    return new Map(rows.map(row => [row.id, {
      state: row.status === null ? "queued"
        : row.lease === null || row.lease <= now ? "interrupted"
        : row.cancelled !== null ? "stopping"
        : row.status === "awaiting_delivery" ? "delivering" : "generating",
      queuedTurns: Number(row.queued),
      startedAt: row.status === null || row.started === null ? null : Number(row.started),
    }]));
  }

  private async attachments(messageIds: number[], scopes: MessageSearchScope[]): Promise<Map<number, SavedAttachment[]>> {
    const result = new Map<number, SavedAttachment[]>();
    if (!messageIds.length) return result;
    const visibleOwner = messageScopePredicate(sql`owner.thread_id`, sql`owner.id`, scopes.map(scope => scope.threadId), scopes);
    const rows = await this.db.query<{
      messageId: number; fileId: string; name: string | null; caption: string | null; description: string | null;
    }>(sql`
      select m.id as "messageId", f.id as "fileId", mf.caption,
        coalesce(mf.display_name, case when ${visibleOwner} then f.name else null end) as name,
        case when f.type = 'image' and ${visibleOwner} then f.summary else null end as description
      from messages m join files f on f.message_id = m.id or exists (
        select 1 from message_files link where link.file_id = f.id and link.message_id = m.id
      )
      left join message_files mf on mf.file_id = f.id and mf.message_id = m.id
      left join messages owner on owner.id = f.message_id
      where m.id in (${valueList(messageIds)}) order by m.id, f.created_at, f.id
    `);
    // Empty scopes provide generic fallback names without borrowing another message's alias.
    const projected = await this.repos.files.listByIds([...new Set(rows.map(row => row.fileId))], []);
    const files = new Map(projected.map(file => [file.id, file]));
    for (const row of rows) {
      const file = files.get(row.fileId);
      if (!file) continue;
      const attachments = result.get(row.messageId) ?? [];
      attachments.push({
        id: file.id, name: row.name ?? file.name, caption: row.caption,
        size: file.size !== null && file.size > 0 ? file.size : null, mimeType: file.mime_type,
        inlineContent: file.is_inline === 1 ? file.content_md : null,
        kind: file.type === "image" || file.type === "audio" ? file.type : "file",
        description: row.description,
      });
      result.set(row.messageId, attachments);
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

  async file(threadId: string, fileId: string) {
    const { chain, scopes } = await this.scope(threadId);
    const rows = await this.db.query<{ id: string }>(sql`
      select f.id from files f join messages m on f.message_id = m.id or exists (
        select 1 from message_files mf where mf.file_id = f.id and mf.message_id = m.id
      ) where f.id = ${fileId}
      and ${messageScopePredicate(sql`m.thread_id`, sql`m.id`, chain.map(t => t.id), scopes)} limit 1
    `);
    if (!rows.length) throw new WebNotFound();
    const file = await this.repos.files.get(fileId, scopes);
    if (!file) throw new WebNotFound();
    return file;
  }
}

function threadView(t: ThreadRow & { lastActivity?: number }, activity: WebThreadActivity | null = null): WebThread {
  return { id: t.id, userId: t.user_id, title: t.title, archived: Boolean(t.archived),
    parentThreadId: t.parent_thread_id, forkPointMessageId: t.fork_point_message_id,
    lastActivity: t.lastActivity ?? t.created_at, activity };
}

function page<T>(rows: T[], offset: number, limit: number): WebPage<T> {
  return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}
