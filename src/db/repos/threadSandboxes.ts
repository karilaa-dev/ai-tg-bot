import { sql } from "drizzle-orm";
import type { ThreadSandboxRow } from "../types.js";
import { queryOne, type SqlExecutor } from "../sql.js";

export class ThreadSandboxesRepo {
  constructor(private readonly db: SqlExecutor) {}

  get(deploymentId: string, threadId: number): Promise<ThreadSandboxRow | undefined> {
    return queryOne<ThreadSandboxRow>(this.db, sql`
      select * from thread_sandboxes
      where deployment_id = ${deploymentId} and thread_id = ${threadId}
    `);
  }

  async insertIfAbsent(input: {
    deploymentId: string;
    userId: number;
    threadId: number;
    sandboxId: string;
  }): Promise<ThreadSandboxRow> {
    const now = Date.now();
    const inserted = await queryOne<ThreadSandboxRow>(this.db, sql`
      insert into thread_sandboxes(
        deployment_id, user_id, thread_id, sandbox_id, created_at, updated_at
      ) values (
        ${input.deploymentId}, ${input.userId}, ${input.threadId}, ${input.sandboxId},
        ${now}, ${now}
      )
      on conflict(deployment_id, thread_id) do nothing
      returning *
    `);
    if (inserted) return inserted;
    const winner = await this.get(input.deploymentId, input.threadId);
    if (!winner) {
      throw new Error("sandbox mapping conflicted but no winning thread mapping was found");
    }
    return winner;
  }

  async remove(deploymentId: string, threadId: number): Promise<void> {
    await this.db.execute(sql`
      delete from thread_sandboxes
      where deployment_id = ${deploymentId} and thread_id = ${threadId}
    `);
  }

  async removeIfMatches(deploymentId: string, threadId: number, sandboxId: string): Promise<void> {
    await this.db.execute(sql`
      delete from thread_sandboxes
      where deployment_id = ${deploymentId}
        and thread_id = ${threadId}
        and sandbox_id = ${sandboxId}
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
