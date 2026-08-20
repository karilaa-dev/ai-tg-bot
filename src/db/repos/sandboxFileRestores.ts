import { sql } from "drizzle-orm";
import type { SandboxFileRestoreStatusRow } from "../types.js";
import { insertReturning, type SqlExecutor } from "../sql.js";

export class SandboxFileRestoresRepo {
  constructor(private readonly db: SqlExecutor) {}

  upsert(input: {
    deploymentId: string;
    threadId: number;
    sandboxId: string;
    fileId: number;
    telegramFileRefId?: number | null;
    sandboxName: string;
    status: SandboxFileRestoreStatusRow["status"];
    restoredSize?: number | null;
    restoredSha256?: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
    attemptedAt: number;
    completedAt?: number | null;
  }): Promise<SandboxFileRestoreStatusRow> {
    return insertReturning<SandboxFileRestoreStatusRow>(this.db, sql`
      insert into sandbox_file_restore_status(
        deployment_id, thread_id, sandbox_id, file_id, telegram_file_ref_id,
        sandbox_name, status, restored_size, restored_sha256, error_code,
        error_detail, attempted_at, completed_at
      ) values (
        ${input.deploymentId}, ${input.threadId}, ${input.sandboxId}, ${input.fileId},
        ${input.telegramFileRefId ?? null}, ${input.sandboxName}, ${input.status},
        ${input.restoredSize ?? null}, ${input.restoredSha256 ?? null},
        ${input.errorCode ?? null}, ${input.errorDetail ?? null}, ${input.attemptedAt},
        ${input.completedAt ?? null}
      )
      on conflict(deployment_id, sandbox_id, file_id) do update set
        telegram_file_ref_id = coalesce(excluded.telegram_file_ref_id, sandbox_file_restore_status.telegram_file_ref_id),
        sandbox_name = excluded.sandbox_name,
        status = excluded.status,
        restored_size = excluded.restored_size,
        restored_sha256 = excluded.restored_sha256,
        error_code = excluded.error_code,
        error_detail = excluded.error_detail,
        attempted_at = excluded.attempted_at,
        completed_at = excluded.completed_at
      returning *
    `);
  }

  listForSandbox(deploymentId: string, sandboxId: string): Promise<SandboxFileRestoreStatusRow[]> {
    return this.db.query<SandboxFileRestoreStatusRow>(sql`
      select * from sandbox_file_restore_status
      where deployment_id = ${deploymentId} and sandbox_id = ${sandboxId}
      order by file_id asc
    `);
  }
}
