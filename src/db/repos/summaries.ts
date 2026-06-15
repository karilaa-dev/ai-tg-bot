import { sql, type SQL } from "drizzle-orm";
import { queryOne, valueList, type SqlExecutor } from "../sql.js";
import type { TextSearch } from "../search.js";
import type { SummaryRow } from "../types.js";

export class SummariesRepo {
  constructor(
    private readonly db: SqlExecutor,
    private readonly search: TextSearch,
  ) {}

  async insert(input: {
    threadId: number;
    level: 0 | 1;
    fromMessageId: number;
    toMessageId: number;
    content: string;
  }): Promise<SummaryRow> {
    const inserted = (await queryOne<SummaryRow>(
      this.db,
      sql`
        insert into summaries(thread_id, level, from_message_id, to_message_id, content, created_at)
        values (${input.threadId}, ${input.level}, ${input.fromMessageId}, ${input.toMessageId}, ${input.content}, ${Date.now()})
        returning *
      `,
    ))!;
    await this.search.indexSummary(inserted.id, input.threadId, inserted.content);
    return inserted;
  }

  listForThreads(threadIds: number[], level?: 0 | 1): Promise<SummaryRow[]> {
    if (!threadIds.length) return Promise.resolve([]);
    const filters: SQL[] = [sql`thread_id in (${valueList(threadIds)})`];
    if (level !== undefined) filters.push(sql`level = ${level}`);
    return this.db.query<SummaryRow>(sql`select * from summaries where ${sql.join(filters, sql` and `)} order by from_message_id asc`);
  }
}
