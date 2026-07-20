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
    return insertReturning<UserRow>(
      this.db,
      sql`
        insert into users(tg_id, first_name, username, lang, tz_offset_min, stream_mode, created_at)
        values (${input.tgId}, ${input.firstName ?? null}, ${input.username ?? null}, ${input.lang ?? "en"}, null, 1, ${now})
        on conflict (tg_id) do update set
          first_name = excluded.first_name,
          username = excluded.username
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
    const user = await this.get(tgId);
    const next = user?.stream_mode ? 0 : 1;
    await this.db.execute(sql`update users set stream_mode = ${next} where tg_id = ${tgId}`);
    return (await this.get(tgId))!;
  }
}
