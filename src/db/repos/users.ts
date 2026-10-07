import { sql } from "drizzle-orm";
import { insertReturning, queryOne, type SqlExecutor } from "../sql.js";
import type { Locale, UserRow } from "../types.js";

export class UsersRepo {
  constructor(private readonly db: SqlExecutor) {}

  get(tgId: number): Promise<UserRow | undefined> {
    return queryOne<UserRow>(this.db, sql`select * from users where tg_id = ${tgId}`);
  }

  async ensure(input: {
    tgId: number;
    firstName?: string;
    username?: string;
    lang?: Locale;
  }): Promise<UserRow> {
    const now = Date.now();
    const searchColumns = this.db.dialect === "postgres" ? sql`, first_name_search, username_search` : sql``;
    const searchValues = this.db.dialect === "postgres"
      ? sql`, ${(input.firstName ?? "").toLowerCase()}, ${(input.username ?? "").toLowerCase()}` : sql``;
    const searchUpdates = this.db.dialect === "postgres"
      ? sql`, first_name_search = excluded.first_name_search, username_search = excluded.username_search` : sql``;
    return insertReturning<UserRow>(
      this.db,
      sql`
        insert into users(tg_id, first_name, username, lang, tz_offset_min, stream_mode, created_at${searchColumns})
        values (${input.tgId}, ${input.firstName ?? null}, ${input.username ?? null}, ${input.lang ?? "en"}, null, 1, ${now}${searchValues})
        on conflict (tg_id) do update set
          first_name = excluded.first_name,
          username = excluded.username${searchUpdates}
        returning *
      `,
    );
  }

  async setLang(tgId: number, lang: Locale): Promise<void> {
    await this.db.execute(sql`update users set lang = ${lang} where tg_id = ${tgId}`);
  }

  async setTimezone(tgId: number, offset: number): Promise<void> {
    await this.db.execute(sql`update users set tz_offset_min = ${offset} where tg_id = ${tgId}`);
  }

  async toggleStream(tgId: number): Promise<UserRow> {
    const user = await queryOne<UserRow>(this.db, sql`
      update users set stream_mode = case when stream_mode = 0 then 1 else 0 end
      where tg_id = ${tgId} returning *
    `);
    if (!user) throw new Error(`User #${tgId} no longer exists.`);
    return user;
  }

  async setMemoryEnabled(tgId: number, enabled: boolean): Promise<UserRow> {
    return this.db.transaction(async tx => {
      // This row also serializes memory writes against a preference change.
      const user = await queryOne<UserRow>(tx, sql`update users set memory_enabled = ${enabled ? 1 : 0}
        where tg_id = ${tgId} returning *`);
      if (!user) throw new Error(`User #${tgId} no longer exists.`);
      return user;
    });
  }
}
