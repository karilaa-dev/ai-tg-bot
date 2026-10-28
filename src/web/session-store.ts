import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../db/sql.js";

/** Only token hashes are stored. Sessions last until sign-out or access revocation. */
export class WebSessionStore {
  constructor(private readonly db: SqlExecutor) {}

  async userId(tokenHash: string): Promise<number | undefined> {
    const row = await queryOne<{ user_id: number }>(this.db, sql`
      select user_id from web_sessions where token_hash = ${tokenHash}
    `);
    return row?.user_id;
  }

  async create(tokenHash: string, userId: number, previousHash?: string): Promise<void> {
    await this.db.transaction(async tx => {
      if (previousHash) await tx.execute(sql`delete from web_sessions where token_hash = ${previousHash}`);
      await tx.execute(sql`insert into web_sessions(token_hash, user_id) values (${tokenHash}, ${userId})`);
    });
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.execute(sql`delete from web_sessions where token_hash = ${tokenHash}`);
  }

  async revokeUser(userId: number): Promise<void> {
    await this.db.execute(sql`delete from web_sessions where user_id = ${userId}`);
  }
}
