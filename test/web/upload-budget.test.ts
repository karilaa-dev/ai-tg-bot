import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createTemporaryUploadLease, requireUploadSpace, UploadBudget, uploadStorageInstance } from "../../src/web/upload-budget.js";

vi.mock("node:fs/promises", async importOriginal => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, stat: vi.fn(filesystem.stat), statfs: vi.fn(filesystem.statfs), link: vi.fn(filesystem.link) };
});

let database: AppDatabase;
let directory: string;
beforeEach(async () => {
  vi.mocked(link).mockImplementation((...args) => vi.importActual<typeof import("node:fs/promises")>("node:fs/promises").then(filesystem => filesystem.link(...args)));
  directory = await mkdtemp(path.join(tmpdir(), "upload-budget-"));
  database = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
  await database.initialize();
});
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(stat).mockReset(); vi.mocked(statfs).mockReset(); vi.mocked(link).mockReset(); await database.destroy(); await rm(directory, { recursive: true, force: true }); });
const config = () => loadTestConfig({ FILE_STORAGE_PATH: directory, WEB_UPLOAD_USER_MAX_BYTES: 10 });

it("serializes reservations across connections and preserves quotas after restart", async () => {
  const other = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
  try {
    const attempts = await Promise.allSettled([
      new UploadBudget(database.db, config()).reserve(42, 8),
      new UploadBudget(other.db, config()).reserve(42, 8),
    ]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === "rejected")).toMatchObject([{ reason: { status: 413 } }]);
    const independent = await new UploadBudget(other.db, config()).reserve(84, 10);
    await independent.release();
    const reserved = attempts.find(attempt => attempt.status === "fulfilled")!;
    await reserved.value.release();
    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 42 });
    const thread = await repos.threads.activeForUserTopic(42, null);
    const file = await repos.files.insertFile({ userId: 42, threadId: thread.id, type: "other", name: "old.bin", size: 8, isInline: false });
    await repos.turnRuns.accept({ userId: 42, threadId: thread.id, chatId: 42, messageThreadId: null, locale: "en",
      kind: "file", content: {}, textPlain: "Legacy upload", sources: [], webRequestId: "legacy_upload_01234567", attachments: [{ fileId: file.id }] });
    await database.destroy();
    database = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
    await database.initialize();
    await expect(new UploadBudget(database.db, config()).reserve(42, 3)).rejects.toMatchObject({ status: 413 });
    const next = await new UploadBudget(database.db, config()).reserve(84, 7);
    await next.release();
  } finally { await other.destroy(); }
});

it("accounts for disk space promised to writes across connections", async () => {
  const other = createDatabase({ DB_URL: `sqlite:${path.join(directory, "test.db")}` });
  const limits = { ...config(), WEB_UPLOAD_MIN_FREE_BYTES: 10 };
  const first = await new UploadBudget(database.db, limits).reserve(42, 5);
  const second = await new UploadBudget(other.db, limits).reserve(84, 5);
  vi.mocked(statfs).mockResolvedValue({ bavail: 16n, bsize: 1n } as never);
  try {
    await first.beforeWrite(5);
    await expect(second.beforeWrite(5)).rejects.toMatchObject({ status: 507 });
    await first.written(5);
    await second.beforeWrite(5);
    await second.written(5);
  } finally { await first.release(); await second.release(); await other.destroy(); }
});

it("keeps temporary and persistent write promises separate on different filesystems", async () => {
  const limits = { ...config(), WEB_UPLOAD_MIN_FREE_BYTES: 10 };
  const persistent = await new UploadBudget(database.db, limits).reserve(42, 5);
  const temporary = await createTemporaryUploadLease(database.db, 84);
  const temporaryDirectory = await mkdtemp(path.join(directory, "temporary-"));
  vi.mocked(statfs).mockResolvedValue({ bavail: 16n, bsize: 1n } as never);
  vi.mocked(stat).mockResolvedValueOnce({ dev: 1n } as never).mockResolvedValueOnce({ dev: 2n } as never);
  try {
    await persistent.beforeWrite(5);
    await temporary.beforeWrite(temporaryDirectory, 5, 10);
    await persistent.written(5);
    await temporary.written(5);
  } finally { await persistent.release(); await temporary.release(); }
});

it("rolls back failed file preparation without losing its reservation", async () => {
  const repos = createRepos(database.db, database.search);
  await repos.users.ensure({ tgId: 42 });
  const thread = await repos.threads.activeForUserTopic(42, null);
  const budget = new UploadBudget(database.db, config());
  const reservation = await budget.reserve(42, 8);
  await expect(reservation.prepareFile(8, async repo => {
    await repo.insertFile({ userId: 42, threadId: thread.id, requireMessage: true,
      type: "other", name: "failed.bin", size: 8, isInline: false });
    throw new Error("preparation failed");
  })).rejects.toThrow("preparation failed");
  expect(await repos.files.listForThreads([thread.id])).toEqual([]);
  await expect(budget.reserve(42, 3)).rejects.toMatchObject({ status: 413 });
  await reservation.release();
  const next = await budget.reserve(42, 10);
  await next.release();
});

it("allows each user their full quota beyond the former shared limit", async () => {
  const budget = new UploadBudget(database.db, loadTestConfig({ FILE_STORAGE_PATH: directory }));
  const reservations = await Promise.all([42, 84, 126].map(userId => budget.reserve(userId, 5 * 1024 ** 3)));
  try {
    await expect(budget.reserve(42, 1)).rejects.toMatchObject({ status: 413 });
  } finally { await Promise.all(reservations.map(reservation => reservation.release())); }
});

it("expires abandoned reservations, renews active ones, and fails closed when disk is full", async () => {
  const budget = new UploadBudget(database.db, config());
  const reservation = await budget.reserve(42, 8);
  await reservation.beforeWrite(8);
  await expect(requireUploadSpace(directory, 1, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ status: 507 });
  await database.db.execute(sql`update web_upload_reservations set expires_at = 0`);
  await expect(reservation.beforeWrite(1)).rejects.toMatchObject({ status: 503 });
  const next = await budget.reserve(42, 8);
  await reservation.release();
  await next.release();
  expect(await database.db.query(sql`select * from web_upload_reservations`)).toEqual([]);
});

describe("storage identity", () => {
  const marker = () => path.join(directory, "volume", ".upload-instance");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const volume = () => path.join(directory, "volume");

  it("publishes only a complete, durable identity and leaves no staging files", async () => {
    let staged = "";
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      // At the moment it becomes visible, the identity is already complete.
      staged = await readFile(String(from), "utf8");
      const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return filesystem.link(from, to);
    });
    const identity = await uploadStorageInstance(volume());
    expect(staged).toBe(`${identity}\n`);
    expect(await readFile(marker(), "utf8")).toBe(`${identity}\n`);
    expect(await readdir(volume())).toEqual([".upload-instance"]);
    expect((await stat(marker())).mode & 0o777).toBe(0o600);
  });

  it("recovers from an interruption before publication without leaving an invalid identity", async () => {
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("interrupted"), { code: "EIO" }));
    await expect(uploadStorageInstance(volume())).rejects.toThrow("interrupted");
    // Nothing was published and the failed attempt cleaned its staging copy.
    expect(await readdir(volume())).toEqual([]);
    const identity = await uploadStorageInstance(volume());
    expect(identity).toMatch(uuid);
    // A staging file stranded by a crash is never mistaken for the identity, then or later.
    await rm(marker());
    await writeFile(path.join(volume(), ".upload-instance.crashed.tmp"), "half");
    const other = path.join(directory, "other");
    await mkdir(other);
    await writeFile(path.join(other, ".upload-instance.crashed.tmp"), "half");
    expect(await uploadStorageInstance(other)).toMatch(uuid);
    expect((await readFile(path.join(other, ".upload-instance"), "utf8")).trim()).toMatch(uuid);
  });

  it("adopts the identity another creator published first instead of overwriting it", async () => {
    vi.mocked(link).mockImplementationOnce(async () => {
      await writeFile(marker(), "11111111-1111-4111-8111-111111111111\n");
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    await mkdir(volume());
    expect(await uploadStorageInstance(volume())).toBe("11111111-1111-4111-8111-111111111111");
    expect(await readFile(marker(), "utf8")).toBe("11111111-1111-4111-8111-111111111111\n");
    expect(await readdir(volume())).toEqual([".upload-instance"]);
  });

  it.each(["", "half-written", "11111111-1111-4111"])("never replaces a corrupt existing identity %j", async contents => {
    await mkdir(volume());
    await writeFile(marker(), contents);
    await expect(uploadStorageInstance(volume())).rejects.toThrow("will not be replaced");
    await expect(uploadStorageInstance(volume())).rejects.toThrow("will not be replaced");
    expect(await readFile(marker(), "utf8")).toBe(contents);
    expect(await readdir(volume())).toEqual([".upload-instance"]);
  });

  it("makes concurrent first starters in separate processes agree on one identity", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    // Each child loads the module, announces it is ready, and only initializes once released, so all six are
    // alive and racing on the same fresh volume at the same moment.
    const script = `const { uploadStorageInstance } = await import(process.env.ROOT + "/src/web/upload-budget.js");
      console.log("ready");
      await new Promise(resolve => process.stdin.once("data", resolve));
      process.stdout.write("identity " + await uploadStorageInstance(process.env.VOLUME) + "\\n", () => process.exit(0));`;
    const children = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, ROOT: root, VOLUME: volume() }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const ready = new Promise<void>(resolve => child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("ready")) resolve(); }));
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exited = new Promise<{ status: number | null; identity: string; stderr: string }>(resolve => child.on("close", status =>
        resolve({ status, identity: /identity (\S+)/.exec(stdout)?.[1] ?? "", stderr })));
      return { child, ready, exited };
    });
    await Promise.all(children.map(entry => entry.ready));
    // Nothing exists yet: every child is waiting at the barrier before the first creation.
    expect(await readdir(directory).then(entries => entries.includes("volume"))).toBe(false);
    for (const { child } of children) child.stdin.write("go\n");
    const results = await Promise.all(children.map(entry => entry.exited));
    expect(results.map(result => [result.status, result.stderr])).toEqual(Array.from({ length: 6 }, () => [0, ""]));
    const identities = new Set(results.map(result => result.identity));
    expect(identities.size).toBe(1);
    expect([...identities][0]).toMatch(uuid);
    expect(await readFile(marker(), "utf8")).toBe(`${[...identities][0]}\n`);
    expect((await stat(marker())).mode & 0o777).toBe(0o600);
    expect(await readdir(volume())).toEqual([".upload-instance"]);
  });
});
