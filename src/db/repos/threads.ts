import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../sql.js";
import type { ThreadRow } from "../types.js";

export class ThreadsRepo {
  constructor(private readonly db: SqlExecutor) {}

  get(id: number): Promise<ThreadRow | undefined> {
    return queryOne<ThreadRow>(this.db, sql`select * from threads where id = ${id}`);
  }

  async activeForUserTopic(userId: number, topicId: number | null, title = "General"): Promise<ThreadRow> {
    const existing = await queryOne<ThreadRow>(
      this.db,
      topicId === null
        ? sql`select * from threads where user_id = ${userId} and archived = 0 and topic_id is null order by id desc limit 1`
        : sql`select * from threads where user_id = ${userId} and archived = 0 and topic_id = ${topicId} order by id desc limit 1`,
    );
    if (existing) return existing;
    return this.create({ userId, topicId, title });
  }

  async create(input: {
    userId: number;
    topicId: number | null;
    title: string;
    parentThreadId?: number | null;
    forkPointMessageId?: number | null;
  }): Promise<ThreadRow> {
    return (await queryOne<ThreadRow>(
      this.db,
      sql`
        insert into threads(user_id, topic_id, parent_thread_id, fork_point_message_id, title, meta_summary, compacted_upto_message_id, archived, created_at)
        values (${input.userId}, ${input.topicId}, ${input.parentThreadId ?? null}, ${input.forkPointMessageId ?? null}, ${input.title}, null, null, 0, ${Date.now()})
        returning *
      `,
    ))!;
  }

  async setCompacted(threadId: number, upto: number, summary: string): Promise<void> {
    await this.db.execute(sql`update threads set compacted_upto_message_id = ${upto}, meta_summary = ${summary} where id = ${threadId}`);
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
