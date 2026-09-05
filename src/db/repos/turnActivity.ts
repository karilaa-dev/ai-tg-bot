import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../sql.js";

const workingState = sql`case when status in ('queued', 'running', 'awaiting_delivery') then 1 else 0 end`;

export class TurnActivityRepo {
  constructor(private readonly db: SqlExecutor) {}

  async pending(now: number): Promise<number[]> {
    const rows = await this.db.query<{ turn_run_id: number }>(sql`
      select turn_run_id from turn_activity_sync a join turn_runs r on r.id = a.turn_run_id
      where (a.synced_working is null or a.synced_working <> ${workingState})
        and a.retry_at <= ${now} and (a.lease_expires_at is null or a.lease_expires_at <= ${now})
      order by a.retry_at, a.turn_run_id limit 100
    `);
    return rows.map((row) => row.turn_run_id);
  }

  async claim(runId: number, ownerId: string, now: number, leaseExpiresAt: number): Promise<number | undefined> {
    const row = await queryOne<{ generation: number }>(this.db, sql`
      update turn_activity_sync set owner_id = ${ownerId}, lease_expires_at = ${leaseExpiresAt},
        synced_working = null, generation = generation + 1
      where turn_run_id = ${runId}
        and (retry_at <= ${now} or (select ${workingState} from turn_runs where id = ${runId}) = 0)
        and (lease_expires_at is null or lease_expires_at <= ${now})
        and (synced_working is null or synced_working <> (select ${workingState} from turn_runs where id = ${runId}))
      returning generation
    `);
    return row?.generation;
  }

  async confirm(runId: number, ownerId: string, generation: number, working: boolean): Promise<boolean> {
    const row = await queryOne<{ turn_run_id: number }>(this.db, sql`
      update turn_activity_sync set synced_working = ${working ? 1 : 0}, owner_id = null, lease_expires_at = null, retry_at = 0
      where turn_run_id = ${runId} and owner_id = ${ownerId} and generation = ${generation}
        and lease_expires_at > ${Date.now()}
        and (select ${workingState} from turn_runs where id = ${runId}) = ${working ? 1 : 0}
      returning turn_run_id
    `);
    return Boolean(row);
  }

  async invalidate(runId: number): Promise<void> {
    await this.db.execute(sql`
      update turn_activity_sync set synced_working = null, generation = generation + 1, retry_at = 0
      where turn_run_id = ${runId}
    `);
  }

  async release(runId: number, ownerId: string, retryAt: number): Promise<void> {
    await this.db.execute(sql`
      update turn_activity_sync set owner_id = null, lease_expires_at = null, retry_at = ${retryAt}
      where turn_run_id = ${runId} and owner_id = ${ownerId}
    `);
  }
}
