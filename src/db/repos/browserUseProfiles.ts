import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { insertReturning, queryOne, type SqlExecutor } from "../sql.js";
import type { BrowserUseProfileRow } from "../types.js";

export class BrowserUseProfilesRepo {
  constructor(private readonly db: SqlExecutor) {}

  get(deploymentId: string, userId: number): Promise<BrowserUseProfileRow | undefined> {
    return queryOne<BrowserUseProfileRow>(this.db, sql`
      select * from browser_use_profiles
      where deployment_id = ${deploymentId} and user_id = ${userId}
    `);
  }

  async ensure(deploymentId: string, userId: number): Promise<BrowserUseProfileRow> {
    const now = Date.now();
    return insertReturning<BrowserUseProfileRow>(this.db, sql`
      insert into browser_use_profiles(
        deployment_id, user_id, provider_user_key, profile_id, created_at, updated_at
      ) values (
        ${deploymentId}, ${userId}, ${randomUUID()}, ${null}, ${now}, ${now}
      )
      on conflict(deployment_id, user_id) do update set
        updated_at = browser_use_profiles.updated_at
      returning *
    `);
  }

  async setProfileId(deploymentId: string, userId: number, profileId: string): Promise<void> {
    await this.db.execute(sql`
      update browser_use_profiles
      set profile_id = ${profileId}, updated_at = ${Date.now()}
      where deployment_id = ${deploymentId} and user_id = ${userId}
    `);
  }
}
