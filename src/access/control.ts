import { sql } from "drizzle-orm";
import { z } from "zod";
import { queryOne, type SqlExecutor } from "../db/sql.js";

const TelegramIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const DatabaseIntegerSchema = z.union([
  z.number(),
  z.string().regex(/^\d+$/).transform(Number),
  z.bigint().transform(Number),
]).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const AllowedUserRowSchema = z.object({
  tg_id: DatabaseIntegerSchema.pipe(TelegramIdSchema),
  first_name: z.string().nullable(),
  username: z.string().nullable(),
  registered_tg_id: DatabaseIntegerSchema.pipe(TelegramIdSchema).nullable(),
  created_at: DatabaseIntegerSchema,
});

export interface AllowedUser {
  telegramId: number;
  firstName: string | null;
  username: string | null;
  registered: boolean;
  createdAt: number;
}

export class AccessControl {
  constructor(private readonly db: SqlExecutor) {}

  async initialize(): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (tx.dialect === "postgres") {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ai-tg-bot:access-control'))`);
      }
      const integerType = tx.dialect === "postgres" ? sql`bigint` : sql`integer`;
      await tx.execute(sql`
        create table if not exists bot_allowed_users (
          tg_id ${integerType} primary key not null check(tg_id > 0 and tg_id <= 9007199254740991),
          created_at ${integerType} not null
        )
      `);
      await tx.execute(sql`
        create table if not exists access_migrations (name text primary key not null)
      `);
      const migration = await queryOne<{ name: string }>(tx, sql`
        insert into access_migrations(name) values ('grandfather_existing_users_v1')
        on conflict (name) do nothing returning name
      `);
      if (migration) {
        await tx.execute(sql`
          insert into bot_allowed_users(tg_id, created_at)
          select tg_id, ${Date.now()} from users where true
          on conflict (tg_id) do nothing
        `);
      }
    });
  }

  async isAllowed(tgId: number): Promise<boolean> {
    const telegramId = TelegramIdSchema.parse(tgId);
    return Boolean(await queryOne(this.db, sql`
      select tg_id from bot_allowed_users where tg_id = ${telegramId}
    `));
  }

  async list(): Promise<AllowedUser[]> {
    const rows = await this.db.query(sql`
      select allowed.tg_id, allowed.created_at, users.first_name, users.username,
        users.tg_id as registered_tg_id
      from bot_allowed_users as allowed
      left join users on users.tg_id = allowed.tg_id
      order by allowed.created_at desc, allowed.tg_id asc
    `);
    return rows.map((row) => {
      const parsed = AllowedUserRowSchema.parse(row);
      return {
        telegramId: parsed.tg_id,
        firstName: parsed.first_name,
        username: parsed.username,
        registered: parsed.registered_tg_id !== null,
        createdAt: parsed.created_at,
      };
    });
  }

  async allow(tgId: number): Promise<void> {
    const telegramId = TelegramIdSchema.parse(tgId);
    await this.db.execute(sql`
      insert into bot_allowed_users(tg_id, created_at) values (${telegramId}, ${Date.now()})
      on conflict (tg_id) do nothing
    `);
  }

  async revoke(tgId: number): Promise<void> {
    const telegramId = TelegramIdSchema.parse(tgId);
    await this.db.execute(sql`delete from bot_allowed_users where tg_id = ${telegramId}`);
  }
}
