import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../sql.js";
import type { InviteRow } from "../types.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export type InviteValidation =
  | { ok: true; invite: InviteRow }
  | { ok: false; reason: "unknown" | "expired" | "exhausted" | "revoked" };

export class InvitesRepo {
  constructor(private readonly db: SqlExecutor) {}

  createCode(): string {
    let code = "";
    for (let i = 0; i < 8; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code || nanoid(8);
  }

  get(code: string): Promise<InviteRow | undefined> {
    return queryOne<InviteRow>(this.db, sql`select * from invites where code = ${code}`);
  }

  list(): Promise<InviteRow[]> {
    return this.db.query<InviteRow>(sql`select * from invites order by created_at desc`);
  }

  async insert(input: {
    code: string;
    maxUses: number;
    expiresAt: number | null;
    createdBy: number;
  }): Promise<InviteRow> {
    await this.db.execute(sql`
      insert into invites(code, max_uses, used_count, expires_at, revoked, created_by, created_at)
      values (${input.code}, ${input.maxUses}, 0, ${input.expiresAt}, 0, ${input.createdBy}, ${Date.now()})
    `);
    return (await this.get(input.code))!;
  }

  async validate(code: string, now = Date.now()): Promise<InviteValidation> {
    const invite = await this.get(code);
    if (!invite) return { ok: false, reason: "unknown" };
    if (invite.revoked) return { ok: false, reason: "revoked" };
    if (invite.expires_at !== null && invite.expires_at < now) return { ok: false, reason: "expired" };
    if (invite.used_count >= invite.max_uses) return { ok: false, reason: "exhausted" };
    return { ok: true, invite };
  }

  async consume(code: string): Promise<void> {
    await this.db.execute(sql`update invites set used_count = used_count + 1 where code = ${code}`);
  }

  async revoke(code: string): Promise<void> {
    await this.db.execute(sql`update invites set revoked = 1 where code = ${code}`);
  }
}

export function isValidInviteCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(code);
}
