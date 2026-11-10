import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { FilesRepo } from "../db/repos/files.js";
import { createTextSearch } from "../db/search.js";
import { queryOne, type SqlExecutor } from "../db/sql.js";
import { isUuid } from "../utils/uuid.js";
import { WebHttpError } from "./auth.js";

type BudgetConfig = Pick<AppConfig, "WEB_UPLOAD_USER_MAX_BYTES" | "WEB_UPLOAD_MIN_FREE_BYTES" | "FILE_STORAGE_PATH">;
const LEASE_MS = 5 * 60_000;

export type UploadArtifactKind = "file" | "directory";
export interface UploadArtifact { kind: UploadArtifactKind; target: string; instance: string }

/** Records a filesystem removal that is still owed. Idempotent per artifact. */
export async function queueUploadCleanup(db: SqlExecutor, artifact: UploadArtifact): Promise<void> {
  const now = Date.now();
  await db.execute(sql`insert into web_upload_cleanup(id, kind, target, instance, attempts, next_attempt_at, created_at)
    values (${randomUUID()}, ${artifact.kind}, ${artifact.target}, ${artifact.instance}, 0, ${now}, ${now})
    on conflict(kind, target) do nothing`);
}

export async function completeUploadCleanup(db: SqlExecutor, kind: UploadArtifactKind, target: string): Promise<void> {
  await db.execute(sql`delete from web_upload_cleanup where kind = ${kind} and target = ${target}`);
}

const storageInstances = new Map<string, Promise<string>>();

/**
 * Identifies one local storage volume, persisted next to the stored files so it survives restarts and container
 * replacement. Processes sharing a database but not a volume therefore never reclaim each other's artifacts.
 */
export function uploadStorageInstance(root: string): Promise<string> {
  const key = path.resolve(root);
  let instance = storageInstances.get(key);
  if (!instance) {
    instance = loadStorageInstance(key);
    storageInstances.set(key, instance);
    instance.catch(() => storageInstances.delete(key));
  }
  return instance;
}

async function loadStorageInstance(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, ".upload-instance");
  for (;;) {
    try {
      const existing = (await readFile(file, "utf8")).trim();
      if (!isUuid(existing)) throw new Error("The upload storage identity file is invalid.");
      return existing;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const created = randomUUID();
    try {
      await writeFile(file, `${created}\n`, { flag: "wx", mode: 0o600 });
      return created;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

export async function requireUploadSpace(directory: string, bytes: number, minimumFree: number): Promise<void> {
  const disk = await statfs(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes) + BigInt(minimumFree)) {
    throw new WebHttpError(507, "File storage is nearly full. Try again after space has been freed.");
  }
}

export async function createTemporaryUploadLease(db: SqlExecutor, userId: number) {
  const id = randomUUID();
  await db.execute(sql`insert into web_upload_reservations(id, user_id, bytes, expires_at)
    values (${id}, ${userId}, 0, ${Date.now() + LEASE_MS})`);
  return diskLease(db, id, userId);
}

function diskLease(db: SqlExecutor, id: string, userId: number) {
  const renew = async (): Promise<boolean> => Boolean(await queryOne(db, sql`update web_upload_reservations
    set expires_at = ${Date.now() + LEASE_MS} where id = ${id} and expires_at > ${Date.now()} returning id`));
  // The owner keeps its lease alive while it works. Once reclamation deletes the row, renewal can never succeed.
  const heartbeat = setInterval(() => void renew().catch(() => undefined), LEASE_MS / 3);
  heartbeat.unref?.();
  return {
    id,
    renew,
    /** Fails if reclamation already claimed this lease, so the caller must stop and clean up its own bytes. */
    assertActive: async () => {
      if (!await renew()) throw new WebHttpError(503, "Upload reservation expired. Try again.");
    },
    /** Durable ownership, in this lease's transaction when `executor` is given. */
    track: (artifact: UploadArtifact, executor: SqlExecutor = db) => executor.execute(sql`
      insert into web_upload_items(id, lease_id, user_id, kind, target, instance, created_at)
      values (${randomUUID()}, ${id}, ${userId}, ${artifact.kind}, ${artifact.target}, ${artifact.instance}, ${Date.now()})`),
    beforeWrite: async (directory: string, size: number, minimumFree: number) => {
      const diskKey = String((await stat(directory, { bigint: true })).dev);
      return db.transaction(async tx => {
        if (tx.dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472616)`);
        const lease = await queryOne(tx, sql`update web_upload_reservations set disk_key = ${diskKey}, expires_at = ${Date.now() + LEASE_MS}
          where id = ${id} and expires_at > ${Date.now()} returning id`);
        if (!lease) throw new WebHttpError(503, "Upload reservation expired. Try again.");
        const pending = await queryOne<{ bytes: number }>(tx, sql`select coalesce(sum(write_bytes), 0) as bytes
          from web_upload_reservations where disk_key = ${diskKey} and expires_at > ${Date.now()}`);
        await requireUploadSpace(directory, size + Number(pending?.bytes ?? 0), minimumFree);
        await tx.execute(sql`update web_upload_reservations set write_bytes = write_bytes + ${size} where id = ${id}`);
      });
    },
    written: (size: number) => db.execute(sql`update web_upload_reservations set write_bytes = write_bytes - ${size} where id = ${id}`),
    /** Completed writes no longer promise disk space; the lease itself may outlive them. */
    settleWrites: () => db.execute(sql`update web_upload_reservations set write_bytes = 0 where id = ${id}`),
    /** Ends the lease. Everything it owned is resolved; `cleanup` lists removals that must still be retried. */
    release: async (cleanup: UploadArtifact[] = []) => {
      clearInterval(heartbeat);
      await db.transaction(async tx => {
        for (const artifact of cleanup) await queueUploadCleanup(tx, artifact);
        await tx.execute(sql`delete from web_upload_items where lease_id = ${id}`);
        await tx.execute(sql`delete from web_upload_reservations where id = ${id}`);
      });
    },
    /** Stops renewing without resolving ownership; the lease expires and reclamation finishes the work. */
    abandon: () => clearInterval(heartbeat),
  };
}

/** Database reservations serialize budgets across requests, service instances and restarts. */
export class UploadBudget {
  constructor(private readonly db: SqlExecutor, private readonly config: BudgetConfig) {}

  async reserve(userId: number, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new WebHttpError(400, "Invalid upload size.");
    const id = randomUUID();
    const instance = await uploadStorageInstance(this.config.FILE_STORAGE_PATH);
    await this.db.transaction(async tx => {
      if (tx.dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472616)`);
      // An expired lease that still owns uploaded artifacts is kept for reclamation, but no longer counts below.
      await tx.execute(sql`delete from web_upload_reservations where expires_at <= ${Date.now()}
        and not exists (select 1 from web_upload_items i where i.lease_id = web_upload_reservations.id)`);
      // New preparations carry requires_message; older uploads are identified by their web turn.
      const used = await queryOne<{ bytes: number }>(tx, sql`
        select coalesce(sum(bytes), 0) as bytes
        from (
          select size as bytes from files f where user_id = ${userId} and (requires_message = 1
            or exists (select 1 from turn_runs r where r.user_message_id = f.message_id and r.origin = 'web'))
          union all select bytes from web_upload_reservations where user_id = ${userId} and expires_at > ${Date.now()}
        ) usage
      `);
      if (Number(used?.bytes ?? 0) + bytes > this.config.WEB_UPLOAD_USER_MAX_BYTES) {
        throw new WebHttpError(413, "Your upload storage limit has been reached. Contact the administrator.");
      }
      await tx.execute(sql`insert into web_upload_reservations(id, user_id, bytes, expires_at)
        values (${id}, ${userId}, ${bytes}, ${Date.now() + LEASE_MS})`);
    });
    const disk = diskLease(this.db, id, userId);
    return {
      /**
       * `own` records the new file's ownership in the same transaction that creates it, so a crash can never
       * leave a prepared file that recovery cannot attribute to this lease.
       */
      prepareFile: <T>(size: number, prepare: (repo: FilesRepo, own: (fileId: string) => Promise<void>) => Promise<T>): Promise<T> => this.db.transaction(async tx => {
        // Transfer reserved bytes to the stored file in one commit, so other instances count them once.
        const lease = await queryOne(tx, sql`update web_upload_reservations set bytes = bytes - ${size}, expires_at = ${Date.now() + LEASE_MS}
          where id = ${id} and expires_at > ${Date.now()} and bytes >= ${size} returning id`);
        if (!lease) throw new WebHttpError(503, "Upload reservation expired. Try again.");
        return prepare(new FilesRepo(tx, createTextSearch(tx, tx.dialect)), fileId => disk.track({ kind: "file", target: fileId, instance }, tx));
      }),
      /** Files and directories this reservation may still owe the filesystem; see UploadRecovery. */
      queueFileCleanup: (tx: SqlExecutor, fileId: string) => queueUploadCleanup(tx, { kind: "file", target: fileId, instance }),
      fileCleaned: (fileId: string) => completeUploadCleanup(this.db, "file", fileId),
      assertActive: disk.assertActive,
      beforeWrite: async (size: number) => {
        await mkdir(this.config.FILE_STORAGE_PATH, { recursive: true, mode: 0o700 });
        await disk.beforeWrite(this.config.FILE_STORAGE_PATH, size, this.config.WEB_UPLOAD_MIN_FREE_BYTES);
      },
      written: disk.written,
      release: () => disk.release(),
      abandon: disk.abandon,
    };
  }
}
