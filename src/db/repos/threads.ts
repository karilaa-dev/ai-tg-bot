import { sql } from "drizzle-orm";
import { insertReturning, queryOne, type SqlExecutor } from "../sql.js";
import type { ThreadRow, ThreadTitleSource } from "../types.js";

export class ThreadsRepo {
  constructor(private readonly db: SqlExecutor) {}

  get(id: number): Promise<ThreadRow | undefined> {
    return queryOne<ThreadRow>(this.db, sql`select * from threads where id = ${id}`);
  }

  telegramTitle(chatId: number, topicId: number): Promise<{ name: string | null; requested_activity_title: string | null } | undefined> {
    return queryOne(this.db, sql`select name, requested_activity_title from telegram_topic_titles where chat_id = ${chatId} and topic_id = ${topicId}`);
  }

  async recordTelegramTitle(chatId: number, topicId: number, name: string | null): Promise<void> {
    await this.db.execute(sql`
      insert into telegram_topic_titles(chat_id, topic_id, name) values (${chatId}, ${topicId}, ${name})
      on conflict(chat_id, topic_id) do update set name = excluded.name
    `);
  }

  async recordActivityTitleRequest(chatId: number, topicId: number, name: string): Promise<void> {
    await this.db.execute(sql`
      insert into telegram_topic_titles(chat_id, topic_id, requested_activity_title) values (${chatId}, ${topicId}, ${name})
      on conflict(chat_id, topic_id) do update set requested_activity_title = excluded.requested_activity_title
    `);
  }

  async activeForUserTopic(
    userId: number,
    topicId: number | null,
    title = "General",
    titleSource: ThreadTitleSource = "explicit",
  ): Promise<ThreadRow> {
    const existing = await queryOne<ThreadRow>(
      this.db,
      topicId === null
        ? sql`select * from threads where user_id = ${userId} and archived = 0 and topic_id is null order by id desc limit 1`
        : sql`select * from threads where user_id = ${userId} and archived = 0 and topic_id = ${topicId} order by id desc limit 1`,
    );
    if (existing) return existing;
    return this.create({ userId, topicId, title, titleSource });
  }

  async create(input: {
    userId: number;
    topicId: number | null;
    title: string;
    titleSource?: ThreadTitleSource;
    parentThreadId?: number | null;
    forkPointMessageId?: number | null;
  }): Promise<ThreadRow> {
    return insertReturning<ThreadRow>(
      this.db,
      sql`
        insert into threads(
          user_id, topic_id, parent_thread_id, fork_point_message_id, title,
          title_source, title_attempts, topic_title_synced,
          pi_session_file, pi_session_id, archived, created_at
        )
        values (
          ${input.userId}, ${input.topicId}, ${input.parentThreadId ?? null}, ${input.forkPointMessageId ?? null}, ${input.title},
          ${input.titleSource ?? "explicit"}, 0, 1,
          null, null, 0, ${Date.now()}
        )
        returning *
      `,
    );
  }

  claimTitleGeneration(threadId: number, maxAttempts: number): Promise<ThreadRow | undefined> {
    return queryOne<ThreadRow>(this.db, sql`
      update threads
      set title_attempts = title_attempts + 1
      where id = ${threadId}
        and title_source = 'placeholder'
        and title_attempts < ${maxAttempts}
      returning *
    `);
  }

  setGeneratedTitleIfPlaceholder(threadId: number, title: string): Promise<ThreadRow | undefined> {
    return queryOne<ThreadRow>(this.db, sql`
      update threads
      set title = ${title}, title_source = 'generated', topic_title_synced = 0
      where id = ${threadId} and title_source = 'placeholder'
      returning *
    `);
  }

  markTopicTitleSynced(threadId: number, title: string): Promise<ThreadRow | undefined> {
    return queryOne<ThreadRow>(this.db, sql`
      update threads
      set topic_title_synced = 1
      where id = ${threadId} and title_source = 'generated' and title = ${title}
      returning *
    `);
  }

  applyTelegramTopicTitle(
    threadId: number,
    title: string,
    implicit: boolean,
  ): Promise<ThreadRow | undefined> {
    if (implicit) {
      return queryOne<ThreadRow>(this.db, sql`
        update threads
        set title = ${title}
        where id = ${threadId} and title_source = 'placeholder'
        returning *
      `);
    }
    return queryOne<ThreadRow>(this.db, sql`
      update threads
      set
        title = ${title},
        title_source = case
          when title_source = 'generated' and title = ${title} then 'generated'
          else 'explicit'
        end,
        topic_title_synced = 1
      where id = ${threadId}
      returning *
    `);
  }

  async setPiSession(threadId: number, sessionFile: string, sessionId: string): Promise<void> {
    await this.db.execute(sql`
      update threads
      set pi_session_file = ${sessionFile}, pi_session_id = ${sessionId}
      where id = ${threadId}
    `);
  }

  async archive(id: number): Promise<void> {
    await this.db.execute(sql`update threads set archived = 1 where id = ${id}`);
  }

  async chain(thread: ThreadRow): Promise<ThreadRow[]> {
    const chain: ThreadRow[] = [thread];
    let current = thread;
    while (current.parent_thread_id !== null) {
      const parent = await this.get(current.parent_thread_id);
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    return chain.reverse();
  }
}
