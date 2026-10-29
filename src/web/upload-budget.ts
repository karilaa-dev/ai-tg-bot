import { randomUUID } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { FilesRepo } from "../db/repos/files.js";
import { createTextSearch } from "../db/search.js";
import { queryOne, type SqlExecutor } from "../db/sql.js";
import { WebHttpError } from "./auth.js";

type BudgetConfig = Pick<AppConfig, "WEB_UPLOAD_USER_MAX_BYTES" | "WEB_UPLOAD_MIN_FREE_BYTES" | "FILE_STORAGE_PATH">;
const LEASE_MS = 5 * 60_000;

export async function requireUploadSpace(directory: string, bytes: number, minimumFree: number): Promise<void> {
  const disk = await statfs(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes) + BigInt(minimumFree)) {
    throw new WebHttpError(507, "File storage is nearly full. Try again after space has been freed.");
  }
}

/** Database reservations serialize budgets across requests, service instances and restarts. */
export class UploadBudget {
  constructor(private readonly db: SqlExecutor, private readonly config: BudgetConfig) {}

  async reserve(userId: number, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new WebHttpError(400, "Invalid upload size.");
    const id = randomUUID();
    await this.db.transaction(async tx => {
      if (tx.dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472616)`);
      await tx.execute(sql`delete from web_upload_reservations where expires_at <= ${Date.now()}`);
      // New preparations carry requires_message; older uploads are identified by their web turn.
      const used = await queryOne<{ bytes: number }>(tx, sql`
        select coalesce(sum(bytes), 0) as bytes
        from (
          select size as bytes from files f where user_id = ${userId} and (requires_message = 1
            or exists (select 1 from turn_runs r where r.user_message_id = f.message_id and r.origin = 'web'))
          union all select bytes from web_upload_reservations where user_id = ${userId}
        ) usage
      `);
      if (Number(used?.bytes ?? 0) + bytes > this.config.WEB_UPLOAD_USER_MAX_BYTES) {
        throw new WebHttpError(413, "Your upload storage limit has been reached. Contact the administrator.");
      }
      await tx.execute(sql`insert into web_upload_reservations(id, user_id, bytes, expires_at)
        values (${id}, ${userId}, ${bytes}, ${Date.now() + LEASE_MS})`);
    });
    return {
      prepareFile: <T>(size: number, prepare: (repo: FilesRepo) => Promise<T>): Promise<T> => this.db.transaction(async tx => {
        // Transfer reserved bytes to the stored file in one commit, so other instances count them once.
        const lease = await queryOne(tx, sql`update web_upload_reservations set bytes = bytes - ${size}, expires_at = ${Date.now() + LEASE_MS}
          where id = ${id} and expires_at > ${Date.now()} and bytes >= ${size} returning id`);
        if (!lease) throw new WebHttpError(503, "Upload reservation expired. Try again.");
        return prepare(new FilesRepo(tx, createTextSearch(tx, tx.dialect)));
      }),
      beforeWrite: async (size: number) => {
        await mkdir(this.config.FILE_STORAGE_PATH, { recursive: true, mode: 0o700 });
        await this.db.transaction(async tx => {
          if (tx.dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472616)`);
          const lease = await queryOne(tx, sql`update web_upload_reservations set expires_at = ${Date.now() + LEASE_MS}
            where id = ${id} and expires_at > ${Date.now()} returning id`);
          if (!lease) throw new WebHttpError(503, "Upload reservation expired. Try again.");
          const pending = await queryOne<{ bytes: number }>(tx, sql`select coalesce(sum(write_bytes), 0) as bytes
            from web_upload_reservations where expires_at > ${Date.now()}`);
          await requireUploadSpace(this.config.FILE_STORAGE_PATH, size + Number(pending?.bytes ?? 0), this.config.WEB_UPLOAD_MIN_FREE_BYTES);
          await tx.execute(sql`update web_upload_reservations set write_bytes = write_bytes + ${size} where id = ${id}`);
        });
      },
      written: (size: number) => this.db.execute(sql`update web_upload_reservations set write_bytes = write_bytes - ${size} where id = ${id}`),
      release: () => this.db.execute(sql`delete from web_upload_reservations where id = ${id}`),
    };
  }
}
