import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { FileResolver } from "../../src/files/resolver.js";
import { readChatUpload } from "../../src/web/chat-upload.js";
import { createTemporaryUploadLease, UploadBudget, uploadStorageInstance } from "../../src/web/upload-budget.js";
import { createUploadDirectory, UploadRecovery, uploadSpoolInstance } from "../../src/web/upload-recovery.js";

const USER = 42;
const root = path.resolve(import.meta.dirname, "../..");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let directory: string;
let temporaryRoot: string;
let storage: string;
let databaseUrl: string;
let databases: AppDatabase[];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "upload-recovery-"));
  temporaryRoot = path.join(directory, "tmp");
  storage = path.join(directory, "files");
  await mkdir(temporaryRoot);
  vi.stubEnv("TMPDIR", temporaryRoot);
  databaseUrl = `sqlite:${path.join(directory, "test.db")}`;
  databases = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const database of databases) await database.destroy();
  await rm(directory, { recursive: true, force: true });
});

const config = (quota = 10) => loadTestConfig({ FILE_STORAGE_PATH: storage, WEB_UPLOAD_USER_MAX_BYTES: quota });

/** An application instance. Opening another one against the same database file is a restart or a second worker. */
async function instance(options: { revokeFile?: (id: string) => Promise<void>; quota?: number } = {}) {
  const database = createDatabase({ DB_URL: databaseUrl });
  databases.push(database);
  await database.initialize();
  const repos = createRepos(database.db, database.search);
  const store = new LocalFileStore(storage);
  const recovery = new UploadRecovery({ db: database.db, config: config(), revokeFile: options.revokeFile ?? (id => store.revoke(id)),
    logger: { info: vi.fn(), warn: vi.fn() } });
  return { database, repos, store, recovery, budget: new UploadBudget(database.db, config(options.quota)) };
}
type App = Awaited<ReturnType<typeof instance>>;

async function seed(app: App, userId = USER) {
  await app.repos.users.ensure({ tgId: userId });
  return app.repos.threads.activeForUserTopic(userId, null);
}

/** What accept() does up to persisting bytes. The returned reservation is never released: the process "died". */
async function prepareUpload(app: App, userId: number, threadId: string, bytes: Buffer, options: { persist?: boolean } = {}) {
  const reservation = await app.budget.reserve(userId, bytes.length);
  const file = await reservation.prepareFile(bytes.length, async (repo, own) => {
    const created = await repo.insertFile({ userId, threadId, requireMessage: true, type: "other", name: "upload.bin",
      contentSha256: hash(bytes), size: bytes.length, isInline: false });
    await own(created.id);
    return created;
  });
  if (options.persist !== false) await app.store.write(file.id, bytes);
  reservation.abandon();
  return { reservation, file };
}

const expireLeases = (app: App) => app.database.db.execute(sql`update web_upload_reservations set expires_at = 0`);
const count = async (app: App, table: string) => Number((await app.database.db.query<{ n: number }>(sql.raw(`select count(*) as n from ${table}`)))[0]!.n);
const exists = (file: string) => stat(file).then(() => true, () => false);
/** Stored bytes, as opposed to the fence a reclaimed key leaves behind. */
/** Regular stored files, ignoring the identity marker and the fences reclaimed keys leave behind. */
const storedFiles = async () => {
  const entries = (await readdir(storage)).filter(entry => !entry.startsWith("."));
  return (await Promise.all(entries.map(async entry => (await stat(path.join(storage, entry))).isFile() ? entry : undefined))).filter(Boolean);
};
/** Live spool directories; a fenced path is a zero-byte file and holds nothing. */
const spools = async (root = temporaryRoot) => {
  const entries = await readdir(root);
  return (await Promise.all(entries.map(async entry => (await stat(path.join(root, entry))).isDirectory() ? entry : undefined))).filter(Boolean);
};
const spoolExists = (directory: string) => stat(directory).then(info => info.isDirectory(), () => false);
const hasBytes = (file: string) => stat(file).then(info => info.isFile(), () => false);
const storedPath = (id: string) => path.join(storage, id);

async function accept(app: App, userId: number, threadId: string, fileId: string, requestId = "accept_request_0123456") {
  return app.repos.turnRuns.accept({ userId, threadId, chatId: userId, messageThreadId: null, locale: "en", kind: "file",
    content: {}, textPlain: "Uploaded", sources: [], webRequestId: requestId, attachments: [{ fileId }] });
}

describe("abandoned web upload preparations", () => {
  it("returns the quota and bytes of a terminated uploader after a restart", async () => {
    const first = await instance();
    const thread = await seed(first);
    const bytes = Buffer.from("12345678");
    const { file } = await prepareUpload(first, USER, thread.id, bytes);
    await expireLeases(first);
    // Expiry alone frees neither the invisible file nor its private bytes.
    await expect(first.budget.reserve(USER, 3)).rejects.toMatchObject({ status: 413 });
    await first.database.destroy();
    databases.splice(databases.indexOf(first.database), 1);

    const restarted = await instance();
    await expect(restarted.budget.reserve(USER, 3)).rejects.toMatchObject({ status: 413 });
    expect(await exists(storedPath(file.id))).toBe(true);
    await restarted.recovery.recover();

    expect(await restarted.repos.files.get(file.id)).toBeUndefined();
    expect(await hasBytes(storedPath(file.id))).toBe(false);
    expect(await count(restarted, "web_upload_items")).toBe(0);
    expect(await count(restarted, "web_upload_cleanup")).toBe(0);
    expect(await count(restarted, "web_upload_reservations")).toBe(0);
    const next = await restarted.budget.reserve(USER, 10);
    await next.release();
  });

  it("recovers an uploader that was killed after committing the file and writing its bytes", async () => {
    const parent = await instance();
    const thread = await seed(parent);
    const script = `
      const { createDatabase } = await import(process.env.ROOT + "/src/db/index.js");
      const { createRepos } = await import(process.env.ROOT + "/src/db/repos/index.js");
      const { LocalFileStore } = await import(process.env.ROOT + "/src/files/localStore.js");
      const { UploadBudget } = await import(process.env.ROOT + "/src/web/upload-budget.js");
      const { loadTestConfig } = await import(process.env.ROOT + "/src/config.js");
      const database = createDatabase({ DB_URL: process.env.DB_URL });
      await database.initialize();
      const bytes = Buffer.from("12345678");
      const budget = new UploadBudget(database.db, loadTestConfig({ FILE_STORAGE_PATH: process.env.STORAGE, WEB_UPLOAD_USER_MAX_BYTES: 10 }));
      const reservation = await budget.reserve(42, bytes.length);
      const file = await reservation.prepareFile(bytes.length, async (repo, own) => {
        const created = await repo.insertFile({ userId: 42, threadId: process.env.THREAD, requireMessage: true, type: "other",
          name: "upload.bin", contentSha256: process.env.HASH, size: bytes.length, isInline: false });
        await own(created.id);
        return created;
      });
      await new LocalFileStore(process.env.STORAGE).write(file.id, bytes);
      console.log(file.id);
      // No finally block runs, no lease is released.
      process.kill(process.pid, "SIGKILL");
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8", env: { ...process.env, ROOT: root, DB_URL: databaseUrl, STORAGE: storage, THREAD: thread.id, HASH: hash(Buffer.from("12345678")) },
    });
    expect(child.signal).toBe("SIGKILL");
    const fileId = child.stdout.trim();
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await exists(storedPath(fileId))).toBe(true);

    await expireLeases(parent);
    await parent.recovery.recover();
    expect(await parent.repos.files.get(fileId)).toBeUndefined();
    expect(await hasBytes(storedPath(fileId))).toBe(false);
    const next = await parent.budget.reserve(USER, 10);
    await next.release();
  });

  it("recovers a crash between committing the preparation and writing any bytes", async () => {
    const app = await instance();
    const thread = await seed(app);
    const { file } = await prepareUpload(app, USER, thread.id, Buffer.from("1234"), { persist: false });
    await expireLeases(app);
    await app.recovery.recover();
    expect(await app.repos.files.get(file.id)).toBeUndefined();
    expect(await storedFiles()).toEqual([]);
  });

  it("keeps active, accepted, shared, other users' and untracked legacy files", async () => {
    const app = await instance({ quota: 1000 });
    const thread = await seed(app);
    const other = await seed(app, 43);
    const abandoned = await prepareUpload(app, USER, thread.id, Buffer.from("aaaa"));
    const acceptedUpload = await prepareUpload(app, USER, thread.id, Buffer.from("bbbb"));
    const sharedUpload = await prepareUpload(app, USER, thread.id, Buffer.from("cccc"));
    const activeUpload = await prepareUpload(app, 43, other.id, Buffer.from("dddd"));
    await accept(app, USER, thread.id, acceptedUpload.file.id);
    const shareTarget = (await accept(app, 43, other.id, activeUpload.file.id, "other_request_01234567")).userMessage;
    await app.repos.files.attachToMessage(shareTarget.id, sharedUpload.file.id, { displayName: "shared.bin" });
    // Untracked artifacts from before durable ownership existed.
    const legacy = await app.repos.files.insertFile({ userId: USER, threadId: thread.id, requireMessage: true, type: "other",
      name: "legacy.bin", contentSha256: hash(Buffer.from("eeee")), size: 4, isInline: false });
    await app.store.write(legacy.id, Buffer.from("eeee"));
    const strayDirectory = path.join(temporaryRoot, `chat-upload-${randomBytes(12).toString("hex")}`);
    await mkdir(strayDirectory);

    // Everyone's lease has expired except user 43's.
    await app.database.db.execute(sql`update web_upload_reservations set expires_at = 0 where user_id = ${USER}`);
    await app.recovery.recover();

    expect(await app.repos.files.get(abandoned.file.id)).toBeUndefined();
    expect(await hasBytes(storedPath(abandoned.file.id))).toBe(false);
    for (const survivor of [acceptedUpload.file, sharedUpload.file, activeUpload.file, legacy]) {
      expect(await app.repos.files.get(survivor.id), survivor.name).toBeDefined();
      expect(await exists(storedPath(survivor.id))).toBe(true);
    }
    expect(await exists(strayDirectory)).toBe(true);
    // Only the active upload still owns anything.
    expect((await app.database.db.query<{ target: string }>(sql`select target from web_upload_items`)).map(row => row.target))
      .toEqual([activeUpload.file.id]);
    // After it expires too, the file it already attached to a message is still preserved.
    await expireLeases(app);
    await app.recovery.recover();
    expect(await app.repos.files.get(activeUpload.file.id)).toBeDefined();
    expect(await count(app, "web_upload_items")).toBe(0);
  });

  it("lets recovery win over an expired owner, which can then neither accept nor republish", async () => {
    const app = await instance();
    const thread = await seed(app);
    const reservation = await app.budget.reserve(USER, 4);
    let fileId = "";
    await reservation.prepareFile(4, async (repo, own) => {
      const created = await repo.insertFile({ userId: USER, threadId: thread.id, requireMessage: true, type: "other",
        name: "slow.bin", contentSha256: hash(Buffer.from("slow")), size: 4, isInline: false });
      await own(created.id);
      fileId = created.id;
    });
    await expireLeases(app);
    await app.recovery.recover();

    await expect(reservation.assertActive()).rejects.toMatchObject({ status: 503 });
    await expect(reservation.prepareFile(1, async () => undefined)).rejects.toMatchObject({ status: 503 });
    await expect(reservation.beforeWrite(1)).rejects.toMatchObject({ status: 503 });
    await expect(accept(app, USER, thread.id, fileId)).rejects.toThrow("does not exist");
    expect(await app.repos.files.get(fileId)).toBeUndefined();
    reservation.abandon();
  });

  it("preserves the file when acceptance wins the race", async () => {
    const app = await instance();
    const thread = await seed(app);
    const { file } = await prepareUpload(app, USER, thread.id, Buffer.from("race"));
    const accepted = await accept(app, USER, thread.id, file.id);
    await expireLeases(app);
    await app.recovery.recover();
    expect(await app.repos.files.get(file.id)).toMatchObject({ message_id: accepted.userMessage.id });
    expect(await exists(storedPath(file.id))).toBe(true);
    expect(await count(app, "web_upload_cleanup")).toBe(0);
  });

  it("keeps a failed filesystem removal as a retryable record after the database rows are gone", async () => {
    let healthy = false;
    const store = new LocalFileStore(storage);
    const app = await instance({ revokeFile: async id => { if (!healthy) throw new Error("disk is busy"); await store.revoke(id); } });
    const thread = await seed(app);
    const { file } = await prepareUpload(app, USER, thread.id, Buffer.from("retry!!!"));
    await expireLeases(app);

    const first = await app.recovery.recover();
    expect(first).toMatchObject({ files: 1, failed: 1 });
    expect(await app.repos.files.get(file.id)).toBeUndefined();
    expect(await exists(storedPath(file.id))).toBe(true);
    expect(await count(app, "web_upload_items")).toBe(0);
    expect(await app.database.db.query(sql`select kind, target, attempts from web_upload_cleanup`)).toEqual([{ kind: "file", target: file.id, attempts: 1 }]);
    // The quota is free even while the bytes wait for their retry.
    const next = await app.budget.reserve(USER, 10);
    await next.release();

    // Not due yet: the backoff keeps a persistent failure from being hammered.
    expect(await app.recovery.recover()).toMatchObject({ retried: 0, failed: 0 });
    healthy = true;
    await app.database.db.execute(sql`update web_upload_cleanup set next_attempt_at = 0`);
    expect(await app.recovery.recover()).toMatchObject({ retried: 1, failed: 0 });
    expect(await hasBytes(storedPath(file.id))).toBe(false);
    expect(await count(app, "web_upload_cleanup")).toBe(0);
  });

  it("converges when two recovery workers run at once, never double counting or going negative", async () => {
    const first = await instance({ quota: 1000 });
    const second = await instance({ quota: 1000 });
    const thread = await seed(first);
    const files = [];
    for (let index = 0; index < 3; index++) files.push((await prepareUpload(first, USER, thread.id, Buffer.from(`file-${index}`), { persist: true })).file);
    await expireLeases(first);
    const results = await Promise.all([first.recovery.recover(), second.recovery.recover()]);
    await Promise.all([first.recovery.recover(), second.recovery.recover()]);

    expect(results.reduce((sum, result) => sum + result.files, 0)).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      expect(await first.repos.files.get(file.id)).toBeUndefined();
      expect(await hasBytes(storedPath(file.id))).toBe(false);
    }
    for (const table of ["web_upload_items", "web_upload_cleanup", "web_upload_reservations"]) expect(await count(first, table), table).toBe(0);
    const usage = await first.database.db.query<{ n: number }>(sql`select coalesce(sum(size), 0) as n from files where requires_message = 1`);
    expect(Number(usage[0]!.n)).toBe(0);
  });

  it("claims only expired leases and leaves one that was renewed in the meantime", async () => {
    const app = await instance();
    const thread = await seed(app);
    const { reservation, file } = await prepareUpload(app, USER, thread.id, Buffer.from("alive!!!"));
    await expireLeases(app);
    // The owner renews before reclamation claims: the lease and its file survive.
    await app.database.db.execute(sql`update web_upload_reservations set expires_at = ${Date.now() + 60_000}`);
    await app.recovery.recover();
    expect(await app.repos.files.get(file.id)).toBeDefined();
    await expect(reservation.assertActive()).resolves.toBeUndefined();
    await reservation.release();
  });
});

describe("a stale writer after reclamation", () => {
  const bytes = Buffer.from("12345678");
  const ledgerIsEmpty = async (app: App) => {
    for (const table of ["web_upload_items", "web_upload_cleanup", "web_upload_reservations"]) expect(await count(app, table), table).toBe(0);
  };

  it("cannot publish a file that was reclaimed while it was paused after preparation, even across a restart", async () => {
    const app = await instance();
    const thread = await seed(app);
    const { file } = await prepareUpload(app, USER, thread.id, bytes, { persist: false });
    await expireLeases(app);
    await app.recovery.recover();
    // Recovery is complete and has forgotten the upload, as far as the database goes.
    await ledgerIsEmpty(app);
    expect(await app.repos.files.get(file.id)).toBeUndefined();

    // The paused writer resumes and tries every way of publishing: the plain write and the resolver's repair path.
    await expect(app.store.write(file.id, bytes)).rejects.toThrow();
    const resolver = new FileResolver(app.repos.files, undefined, app.store);
    await expect(resolver.persistFile(file, bytes)).rejects.toThrow();
    await expect(app.store.repair(file.id, bytes, { size: bytes.length, contentSha256: hash(bytes) })).rejects.toThrow();
    expect(await hasBytes(storedPath(file.id))).toBe(false);

    // The process dies before its request-finally; a restarted instance finds nothing to recover and nothing published.
    const restarted = await instance();
    await restarted.recovery.drain();
    expect(await storedFiles()).toEqual([]);
    expect((await stat(storedPath(file.id))).isDirectory()).toBe(true);
    await ledgerIsEmpty(restarted);
    const next = await restarted.budget.reserve(USER, 10);
    await next.release();
  });

  it("removes bytes a stale writer published after recovery resolved the database but before it revoked the key", async () => {
    let published = false;
    const app = await instance();
    const late = await instance({ revokeFile: async id => {
      // The writer's publication lands in the window between reclamation's database work and its revocation.
      if (!published) { published = true; await app.store.write(id, bytes); }
      await app.store.revoke(id);
    } });
    const thread = await seed(app);
    const { file } = await prepareUpload(app, USER, thread.id, bytes, { persist: false });
    await expireLeases(app);
    await late.recovery.recover();
    expect(published).toBe(true);
    expect(await storedFiles()).toEqual([]);
    await expect(app.store.write(file.id, bytes)).rejects.toThrow();
    await ledgerIsEmpty(app);
  });

  it("keeps the revocation owed until it succeeds, however long the writer stays paused", async () => {
    let healthy = false;
    const app = await instance({ revokeFile: async id => { if (!healthy) throw new Error("disk is busy"); await app.store.revoke(id); } });
    const thread = await seed(app);
    const { file } = await prepareUpload(app, USER, thread.id, bytes, { persist: false });
    await expireLeases(app);
    await app.recovery.recover();
    // The writer publishes while revocation is failing: nothing is fenced yet, but the debt is durable.
    await app.store.write(file.id, bytes);
    expect(await hasBytes(storedPath(file.id))).toBe(true);
    expect(await app.database.db.query(sql`select kind, target from web_upload_cleanup`)).toEqual([{ kind: "file", target: file.id }]);
    healthy = true;
    await app.database.db.execute(sql`update web_upload_cleanup set next_attempt_at = 0`);
    const fresh = await instance();
    await fresh.recovery.recover();
    expect(await storedFiles()).toEqual([]);
    await expect(fresh.store.write(file.id, bytes)).rejects.toThrow();
    await ledgerIsEmpty(fresh);
  });

  it("fences a spool path recorded but not yet created, so the paused writer's mkdir fails", async () => {
    const app = await instance();
    const storageInstance = await uploadStorageInstance(storage);
    const lease = await createTemporaryUploadLease(app.database.db, USER);
    let token = "";
    // Recovery claims the lease after the directory is recorded and before createUploadDirectory creates it.
    const racing = {
      track: async (artifact: { kind: "file" | "directory"; target: string; instance: string }) => {
        await lease.track(artifact);
        token = artifact.target;
        await expireLeases(app);
        await app.recovery.recover();
      },
    };
    await expect(createUploadDirectory(racing, storageInstance)).rejects.toMatchObject({ status: 503 });
    lease.abandon();
    // Nothing a writer could use exists, only the zero-byte fence, and the ledger holds no debt.
    expect(await spools()).toEqual([]);
    const fence = await stat(path.join(temporaryRoot, token));
    expect(fence.isFile() && fence.size === 0).toBe(true);
    await ledgerIsEmpty(app);
    const restarted = await instance();
    await restarted.recovery.drain();
    expect(await spools()).toEqual([]);
    await ledgerIsEmpty(restarted);
  });

  it("stops a writer already inside a reclaimed spool from creating files there", async () => {
    const app = await instance();
    const storageInstance = await uploadStorageInstance(storage);
    const lease = await createTemporaryUploadLease(app.database.db, USER);
    const { directory: spool } = await createUploadDirectory(lease, storageInstance);
    await writeFile(path.join(spool, "0"), "partial upload");
    lease.abandon();
    await expireLeases(app);
    await app.recovery.recover();
    expect(await spools()).toEqual([]);
    await expect(writeFile(path.join(spool, "1"), "late", { flag: "wx" })).rejects.toBeDefined();
    await expect(mkdir(spool)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await spools()).toEqual([]);
    await ledgerIsEmpty(app);
  });
});

describe("abandoned upload directories", () => {
  async function upload(app: App, instanceId: string) {
    const body = new Blob([
      `--b\r\nContent-Disposition: form-data; name="requestId"\r\n\r\nrequest_0123456789\r\n`,
      `--b\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\nhello\r\n--b--\r\n`,
    ]);
    return readChatUpload(new Request("https://chat.example/upload", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=b" }, body,
    }), app.database.db, USER, 1, instanceId);
  }

  it("keeps an active upload's spool until disposal ends its lease, and reclaims it after a crash", async () => {
    const app = await instance();
    const storageInstance = await uploadStorageInstance(storage);
    const live = await upload(app, storageInstance);
    const spool = (await readdir(temporaryRoot)).map(entry => path.join(temporaryRoot, entry));
    expect(spool).toHaveLength(1);
    // Parsing is over, but the lease and record last until disposal.
    expect(await count(app, "web_upload_items")).toBe(1);
    expect(await count(app, "web_upload_reservations")).toBe(1);
    await app.recovery.recover();
    expect(await exists(spool[0]!)).toBe(true);
    await live.dispose();
    expect(await spools()).toEqual([]);
    expect(await count(app, "web_upload_items")).toBe(0);
    expect(await count(app, "web_upload_reservations")).toBe(0);

    // A request that dies before disposal leaves a record that recovery resolves once the lease expires.
    const crashed = await upload(app, storageInstance);
    const [token] = await readdir(temporaryRoot);
    expect(await app.database.db.query(sql`select kind, target from web_upload_items`)).toEqual([{ kind: "directory", target: token }]);
    await expireLeases(app);
    void crashed;
    await app.recovery.recover();
    expect(await spools()).toEqual([]);
    expect(await count(app, "web_upload_items")).toBe(0);
    expect(await count(app, "web_upload_cleanup")).toBe(0);
  });

  it("never forgets a spool that lives under another process's temporary root on the shared persistent volume", async () => {
    const rootA = path.join(directory, "tmp-a");
    const rootB = path.join(directory, "tmp-b");
    await mkdir(rootA);
    await mkdir(rootB);
    // Two workers share the database and the storage volume (one volume identity) but not /tmp.
    const worker = await instance();
    vi.stubEnv("TMPDIR", rootA);
    const crashed = await upload(worker, await uploadStorageInstance(storage));
    void crashed;
    const [token] = await readdir(rootA);
    expect(token).toMatch(/^chat-upload-/);
    await expireLeases(worker);

    const other = new UploadRecovery({ db: worker.database.db, config: config(), revokeFile: id => worker.store.revoke(id), tempRoot: () => rootB });
    await other.recover();
    // The other worker's recovery can neither see the directory nor erase the record of it.
    expect(await spoolExists(path.join(rootA, token!))).toBe(true);
    expect(await worker.database.db.query(sql`select kind, target from web_upload_items`)).toEqual([{ kind: "directory", target: token }]);
    expect(await count(worker, "web_upload_cleanup")).toBe(0);

    const owner = new UploadRecovery({ db: worker.database.db, config: config(), revokeFile: id => worker.store.revoke(id), tempRoot: () => rootA });
    await owner.recover();
    expect(await spools(rootA)).toEqual([]);
    expect(await count(worker, "web_upload_items")).toBe(0);
  });

  it("keeps an owed directory removal for the root that owns it", async () => {
    const rootA = path.join(directory, "tmp-a");
    const rootB = path.join(directory, "tmp-b");
    await mkdir(rootA);
    await mkdir(rootB);
    const worker = await instance();
    const volume = await uploadStorageInstance(storage);
    const token = `chat-upload-${randomBytes(12).toString("hex")}`;
    await mkdir(path.join(rootA, token));
    await worker.database.db.execute(sql`insert into web_upload_cleanup(id, kind, target, instance, attempts, next_attempt_at, created_at)
      values ('owed', 'directory', ${token}, ${uploadSpoolInstance(volume, rootA)}, 0, 0, 1)`);
    await new UploadRecovery({ db: worker.database.db, config: config(), revokeFile: async () => undefined, tempRoot: () => rootB }).recover();
    expect(await spoolExists(path.join(rootA, token))).toBe(true);
    expect(await count(worker, "web_upload_cleanup")).toBe(1);
    await new UploadRecovery({ db: worker.database.db, config: config(), revokeFile: async () => undefined, tempRoot: () => rootA }).recover();
    expect(await spoolExists(path.join(rootA, token))).toBe(false);
    expect(await count(worker, "web_upload_cleanup")).toBe(0);
  });

  it("resolves a record whose directory was never created", async () => {
    const app = await instance();
    const storageInstance = await uploadStorageInstance(storage);
    const token = `chat-upload-${randomBytes(12).toString("hex")}`;
    await app.database.db.execute(sql`insert into web_upload_items(id, lease_id, user_id, kind, target, instance, created_at)
      values ('item-1', 'missing-lease', ${USER}, 'directory', ${token}, ${uploadSpoolInstance(storageInstance, temporaryRoot)}, 1)`);
    await app.recovery.recover();
    expect(await count(app, "web_upload_items")).toBe(0);
    expect(await count(app, "web_upload_cleanup")).toBe(0);
  });

  it("never deletes through a tampered record, a symlink, or another storage instance's directory", async () => {
    const app = await instance();
    const storageInstance = await uploadStorageInstance(storage);
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "precious"), "keep");
    const linked = `chat-upload-${randomBytes(12).toString("hex")}`;
    await symlink(outside, path.join(temporaryRoot, linked));
    const foreign = `chat-upload-${randomBytes(12).toString("hex")}`;
    await mkdir(path.join(temporaryRoot, foreign));
    const spool = uploadSpoolInstance(storageInstance, temporaryRoot);
    const records: Array<[string, string, string]> = [
      [outside, "directory", spool], ["../outside", "directory", spool], ["/etc", "directory", spool],
      ["chat-upload-../outside", "directory", spool], [linked, "directory", spool], [foreign, "directory", "another-host-volume"],
      ["../outside/precious", "file", storageInstance], ["not-a-uuid", "file", storageInstance],
    ];
    for (const [index, [target, kind, owner]] of records.entries()) {
      await app.database.db.execute(sql`insert into web_upload_cleanup(id, kind, target, instance, attempts, next_attempt_at, created_at)
        values (${`cleanup-${index}`}, ${kind}, ${target}, ${owner}, 0, 0, 1)`);
    }
    await app.recovery.recover();
    expect(await exists(path.join(outside, "precious"))).toBe(true);
    expect(await exists(path.join(temporaryRoot, foreign))).toBe(true);
    // The symlink itself is not followed and not treated as a spool directory.
    expect(await exists(path.join(temporaryRoot, linked, "precious"))).toBe(true);
    expect(await exists(path.join(directory, "tmp"))).toBe(true);
    // Only the foreign instance's record is left for its own owner; unusable local records are dropped.
    expect(await app.database.db.query(sql`select target from web_upload_cleanup`)).toEqual([{ target: foreign }]);
  });
});

describe("recovery storage", () => {
  it("keeps pending records and ownership across repeated schema initialization", async () => {
    const app = await instance();
    await app.database.db.execute(sql`insert into web_upload_cleanup(id, kind, target, instance, attempts, next_attempt_at, created_at)
      values ('pending', 'file', '00000000-0000-4000-8000-000000000001', 'other-volume', 3, ${Date.now() + 1000}, 1)`);
    await app.database.initialize();
    await app.database.destroy();
    databases.splice(databases.indexOf(app.database), 1);
    const reopened = await instance();
    expect(await reopened.database.db.query(sql`select id, attempts from web_upload_cleanup`)).toEqual([{ id: "pending", attempts: 3 }]);
  });

  it("identifies a storage volume by a persisted marker and rejects a corrupted one", async () => {
    const first = await uploadStorageInstance(storage);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await uploadStorageInstance(path.join(storage, "."))).toBe(first);
    const other = path.join(directory, "other-volume");
    await mkdir(other);
    await writeFile(path.join(other, ".upload-instance"), "not an identity\n");
    await expect(uploadStorageInstance(other)).rejects.toThrow("invalid");
  });

  it("removes staging copies left by a writer that died while publishing a stored file", async () => {
    const store = new LocalFileStore(storage);
    const id = "00000000-0000-4000-8000-0000000000aa";
    await store.write(id, Buffer.from("bytes"));
    const staging = path.join(storage, `${id}.11111111-1111-4111-8111-111111111111.tmp`);
    const unrelated = path.join(storage, "00000000-0000-4000-8000-0000000000bb.11111111-1111-4111-8111-111111111111.tmp");
    await writeFile(staging, "partial");
    await writeFile(unrelated, "someone else's");
    await store.remove(id);
    expect(await exists(path.join(storage, id))).toBe(false);
    expect(await exists(staging)).toBe(false);
    expect(await exists(unrelated)).toBe(true);
  });
});

// The same recovery guarantees against PostgreSQL's row locks and advisory locks, in an isolated schema.
describe.skipIf(!process.env.TEST_POSTGRES_URL)("upload recovery on PostgreSQL", () => {
  let admin: AppDatabase;
  let schema: string;
  beforeEach(async () => {
    schema = `upload_recovery_${randomUUID().replaceAll("-", "")}`;
    admin = createDatabase({ DB_URL: process.env.TEST_POSTGRES_URL! });
    await admin.db.execute(sql.raw(`create schema ${schema}`));
    const url = new URL(process.env.TEST_POSTGRES_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    databaseUrl = url.toString();
  });
  afterEach(async () => {
    for (const database of databases.splice(0)) await database.destroy();
    await admin.db.execute(sql.raw(`drop schema ${schema} cascade`));
    await admin.destroy();
  });

  it("reclaims abandoned uploads, keeps accepted and shared files, and converges across workers", async () => {
    const first = await instance({ quota: 1000 });
    const second = await instance({ quota: 1000 });
    const thread = await seed(first);
    const abandoned = await prepareUpload(first, USER, thread.id, Buffer.from("aaaa"));
    const acceptedUpload = await prepareUpload(first, USER, thread.id, Buffer.from("bbbb"));
    const sharedUpload = await prepareUpload(first, USER, thread.id, Buffer.from("cccc"));
    const accepted = await accept(first, USER, thread.id, acceptedUpload.file.id);
    const other = await seed(first, 43);
    const target = (await accept(first, 43, other.id, (await prepareUpload(first, 43, other.id, Buffer.from("dddd"))).file.id, "other_request_01234567")).userMessage;
    await first.repos.files.attachToMessage(target.id, sharedUpload.file.id, { displayName: "shared.bin" });
    await expireLeases(first);

    await Promise.all([first.recovery.recover(), second.recovery.recover()]);
    await Promise.all([first.recovery.recover(), second.recovery.recover()]);

    expect(await first.repos.files.get(abandoned.file.id)).toBeUndefined();
    expect(await hasBytes(storedPath(abandoned.file.id))).toBe(false);
    expect(await first.repos.files.get(acceptedUpload.file.id)).toMatchObject({ message_id: accepted.userMessage.id });
    expect(await first.repos.files.get(sharedUpload.file.id)).toBeDefined();
    expect(await exists(storedPath(sharedUpload.file.id))).toBe(true);
    for (const table of ["web_upload_items", "web_upload_cleanup", "web_upload_reservations"]) expect(await count(first, table), table).toBe(0);
  });

  it("stops an expired owner after recovery claims its lease", async () => {
    const app = await instance();
    const thread = await seed(app);
    const { reservation, file } = await prepareUpload(app, USER, thread.id, Buffer.from("race"));
    await expireLeases(app);
    await app.recovery.recover();
    await expect(reservation.assertActive()).rejects.toMatchObject({ status: 503 });
    await expect(accept(app, USER, thread.id, file.id)).rejects.toThrow("does not exist");
  });
});
