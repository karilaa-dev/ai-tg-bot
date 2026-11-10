import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { FilesRepo } from "../db/repos/files.js";
import { createTextSearch } from "../db/search.js";
import { queryOne, type SqlExecutor } from "../db/sql.js";
import type { Logger } from "../logger.js";
import { isUuid } from "../utils/uuid.js";
import { queueUploadCleanup, uploadStorageInstance, type UploadArtifact, type UploadArtifactKind } from "./upload-budget.js";

const DIRECTORY_TOKEN = /^chat-upload-[0-9a-f]{24}$/;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
const CLAIM_MS = 60_000;
const DEFAULT_BATCH = 25;
const DEFAULT_INTERVAL_MS = 60_000;

interface DirectoryLease {
  track(artifact: UploadArtifact): Promise<unknown>;
}

/**
 * Creates a request's private spool directory. It is recorded durably *before* it exists, so a crash between the
 * two steps leaves a record that recovery can resolve. Only the generated token is recorded, never a path.
 */
export async function createUploadDirectory(lease: DirectoryLease, instance: string): Promise<{ token: string; directory: string }> {
  const token = `chat-upload-${randomBytes(12).toString("hex")}`;
  await lease.track({ kind: "directory", target: token, instance });
  const directory = path.join(tmpdir(), token);
  await mkdir(directory, { mode: 0o700 });
  return { token, directory };
}

export interface UploadRecoveryResult { leases: number; files: number; directories: number; retried: number; failed: number }

/**
 * Reclaims uploads whose request died before accepting them. Ownership is durable (`web_upload_items`), the lease
 * expiry decides abandonment, and filesystem removals are retried from `web_upload_cleanup` until they succeed.
 *
 * Only artifacts recorded for this storage volume are touched, and only what was recorded: files by UUID and
 * directories by generated token under the temporary root. Historical artifacts that were never recorded are not
 * guessed at or deleted.
 */
export class UploadRecovery {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;

  constructor(private readonly input: {
    db: SqlExecutor;
    config: Pick<AppConfig, "FILE_STORAGE_PATH">;
    removeFile(fileId: string): Promise<void>;
    logger?: Pick<Logger, "warn" | "info">;
    tempRoot?: () => string;
  }) {}

  /** One bounded pass: claim expired leases, resolve what they owned, then retry owed removals. */
  async recover(options: { batch?: number } = {}): Promise<UploadRecoveryResult> {
    const batch = options.batch ?? DEFAULT_BATCH;
    const instance = await uploadStorageInstance(this.input.config.FILE_STORAGE_PATH);
    const result: UploadRecoveryResult = { leases: 0, files: 0, directories: 0, retried: 0, failed: 0 };
    const leases = await this.input.db.query<{ lease_id: string }>(sql`
      select distinct i.lease_id from web_upload_items i
      left join web_upload_reservations r on r.id = i.lease_id
      where i.instance = ${instance} and (r.id is null or r.expires_at <= ${Date.now()})
      limit ${batch}
    `);
    for (const { lease_id: leaseId } of leases) {
      if (!await this.claim(leaseId)) continue;
      result.leases++;
      for (const item of await this.input.db.query<{ id: string; kind: UploadArtifactKind; target: string }>(sql`
        select id, kind, target from web_upload_items where lease_id = ${leaseId} and instance = ${instance}`)) {
        if (await this.resolve(item, instance)) result[item.kind === "file" ? "files" : "directories"]++;
      }
    }
    await this.retry(instance, batch, result);
    return result;
  }

  /** Repeats bounded passes until nothing more is claimed, e.g. at startup. */
  async drain(maxPasses = 40): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass++) {
      const result = await this.recover();
      if (!result.leases && !result.retried) return;
    }
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private pass(): Promise<unknown> {
    return this.running ??= this.recover().catch(error => {
      this.input.logger?.warn("upload recovery failed", { error: String(error) });
    }).finally(() => { this.running = undefined; });
  }

  /**
   * Deleting the lease row is the claim: from then on its owner can no longer renew, prepare files or write
   * under it. The check and the delete are one statement, so a renewal that wins first keeps the lease.
   */
  private claim(leaseId: string): Promise<boolean> {
    return this.input.db.transaction(async tx => {
      if (tx.dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472616)`);
      const claimed = await queryOne(tx, sql`delete from web_upload_reservations
        where id = ${leaseId} and expires_at <= ${Date.now()} returning id`);
      if (claimed) return true;
      // Items without a lease (an interrupted earlier claim) are resolved; a live, renewed lease is left alone.
      return !await queryOne(tx, sql`select 1 from web_upload_reservations where id = ${leaseId}`);
    });
  }

  /** Re-checks ownership under the file's row lock, the same lock acceptance takes when it attaches the file. */
  private async resolve(item: { id: string; kind: UploadArtifactKind; target: string }, instance: string): Promise<boolean> {
    return this.input.db.transaction(async tx => {
      let reclaimed = false;
      if (item.kind === "directory") {
        await queueUploadCleanup(tx, { kind: "directory", target: item.target, instance });
        reclaimed = true;
      } else {
        const file = await queryOne<{ message_id: number | null }>(tx, sql`
          select message_id from files where id = ${item.target} ${tx.dialect === "postgres" ? sql`for update` : sql``}`);
        // A missing row may still have bytes from a writer that outlived its lease; remove them too.
        const attached = file && (file.message_id !== null || await queryOne(tx, sql`select 1 from message_files where file_id = ${item.target} limit 1`));
        if (!attached) {
          if (file) await new FilesRepo(tx, createTextSearch(tx, tx.dialect)).deleteFile(item.target);
          await queueUploadCleanup(tx, { kind: "file", target: item.target, instance });
          reclaimed = true;
        }
      }
      await tx.execute(sql`delete from web_upload_items where id = ${item.id}`);
      return reclaimed;
    });
  }

  private async retry(instance: string, batch: number, result: UploadRecoveryResult): Promise<void> {
    const due = await this.input.db.query<{ id: string; kind: UploadArtifactKind; target: string; attempts: number }>(sql`
      select id, kind, target, attempts from web_upload_cleanup
      where instance = ${instance} and next_attempt_at <= ${Date.now()}
      order by next_attempt_at, id limit ${batch}
    `);
    for (const entry of due) {
      // Claiming pushes the attempt back, so concurrent workers do not repeat the same removal.
      const claimed = await queryOne(this.input.db, sql`update web_upload_cleanup set next_attempt_at = ${Date.now() + CLAIM_MS}
        where id = ${entry.id} and next_attempt_at <= ${Date.now()} returning id`);
      if (!claimed) continue;
      try {
        await this.remove(entry.kind, entry.target);
        await this.input.db.execute(sql`delete from web_upload_cleanup where id = ${entry.id}`);
        result.retried++;
      } catch (error) {
        result.failed++;
        const attempts = Number(entry.attempts) + 1;
        this.input.logger?.warn("upload cleanup will be retried", { kind: entry.kind, attempts, error: String(error) });
        await this.input.db.execute(sql`update web_upload_cleanup set attempts = ${attempts},
          next_attempt_at = ${Date.now() + Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 16), RETRY_MAX_MS)} where id = ${entry.id}`);
      }
    }
  }

  private async remove(kind: UploadArtifactKind, target: string): Promise<void> {
    if (kind === "file") {
      if (!isUuid(target)) return;
      await this.input.removeFile(target);
      return;
    }
    // A database value is never a path: rebuild it from a validated token under the trusted temporary root.
    if (!DIRECTORY_TOKEN.test(target)) return;
    const directory = path.join(this.input.tempRoot?.() ?? tmpdir(), target);
    let stats;
    try { stats = await lstat(directory); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    // Never follow or delete a link or foreign entry that took the place of the spool directory.
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    await rm(directory, { recursive: true, force: true });
  }
}
