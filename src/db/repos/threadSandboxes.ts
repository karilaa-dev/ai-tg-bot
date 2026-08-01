import { sql } from "drizzle-orm";
import type { ThreadSandboxRow } from "../types.js";
import { insertReturning, queryOne, type SqlExecutor } from "../sql.js";

export class ThreadSandboxesRepo {
  constructor(private readonly db: SqlExecutor) {}

  get(deploymentId: string, threadId: number): Promise<ThreadSandboxRow | undefined> {
    return queryOne<ThreadSandboxRow>(this.db, sql`
      select * from thread_sandboxes
      where deployment_id = ${deploymentId} and thread_id = ${threadId}
    `);
  }

  async withCreationLock<T>(
    deploymentId: string,
    threadId: number,
    callback: (repo: ThreadSandboxesRepo) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      if (tx.dialect === "postgres") {
        await tx.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${`${deploymentId}:${threadId}`}, 0))
        `);
      }
      return callback(new ThreadSandboxesRepo(tx));
    });
  }

  upsert(input: {
    deploymentId: string;
    userId: number;
    threadId: number;
    sandboxId: string;
  }): Promise<ThreadSandboxRow> {
    const now = Date.now();
    return insertReturning<ThreadSandboxRow>(this.db, sql`
      insert into thread_sandboxes(
        deployment_id, user_id, thread_id, sandbox_id, created_at, updated_at
      ) values (
        ${input.deploymentId}, ${input.userId}, ${input.threadId}, ${input.sandboxId},
        ${now}, ${now}
      )
      on conflict(deployment_id, thread_id) do update set
        user_id = excluded.user_id,
        sandbox_id = excluded.sandbox_id,
        updated_at = excluded.updated_at
      returning *
    `);
  }

  async remove(deploymentId: string, threadId: number): Promise<void> {
    await this.db.execute(sql`
      delete from thread_sandboxes
      where deployment_id = ${deploymentId} and thread_id = ${threadId}
    `);
  }

  async removeBySandboxIds(sandboxIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(sandboxIds.filter(Boolean))];
    if (!uniqueIds.length) return;
    await this.db.transaction(async (tx) => {
      for (const sandboxId of uniqueIds) {
        await tx.execute(sql`
          delete from thread_sandboxes
          where sandbox_id = ${sandboxId}
        `);
      }
    });
  }
}
