import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { readUpgradeAuditEnvironmentOrFile } from "../src/upgrade/environment.js";

const outputFile = parseArguments(process.argv.slice(2));
const databaseFile = parseSqliteDatabasePath(readUpgradeAuditEnvironmentOrFile("DB_URL"));

await assertRegularFile(databaseFile, "source SQLite database");
await assertRegularDirectory(path.dirname(outputFile), "backup destination directory");
await assertMissing(outputFile);
if (databaseFile === outputFile) throw new Error("SQLite source and backup destination must be different files.");

let source: Database.Database | undefined;
try {
  source = new Database(databaseFile, { readonly: true, fileMustExist: true });
  await source.backup(outputFile);
  await fs.chmod(outputFile, 0o600);
  await normalizeAndVerify(outputFile);
} catch (error) {
  await Promise.all([
    fs.rm(outputFile, { force: true }),
    fs.rm(`${outputFile}-wal`, { force: true }),
    fs.rm(`${outputFile}-shm`, { force: true }),
  ]).catch(() => undefined);
  throw error;
} finally {
  source?.close();
}

process.stdout.write(`${JSON.stringify({
  status: "sqlite-backup-created",
  source: databaseFile,
  output: outputFile,
})}\n`);

function parseArguments(args: string[]): string {
  const [flag, file, ...rest] = args;
  if (flag !== "--out" || !file || rest.length) {
    throw new Error("Usage: node dist/scripts/upgrade-export-sqlite.js --out <database-file>");
  }
  return path.resolve(file);
}

function parseSqliteDatabasePath(dbUrl: string): string {
  if (!dbUrl.startsWith("sqlite:")) {
    throw new Error("SQLite export requires a sqlite: DB_URL.");
  }
  const target = dbUrl.slice("sqlite:".length);
  if (!target || target === ":memory:") {
    throw new Error("SQLite export requires a file-backed DB_URL.");
  }
  return path.resolve(target);
}

async function normalizeAndVerify(file: string): Promise<void> {
  const backup = new Database(file, { fileMustExist: true });
  try {
    const journalMode = backup.pragma("journal_mode = delete", { simple: true });
    if (journalMode !== "delete") throw new Error("SQLite backup could not switch to delete journal mode.");
    const rows = backup.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] || {})[0] !== "ok") {
      throw new Error("SQLite backup integrity_check did not return ok.");
    }
  } finally {
    backup.close();
  }
  await Promise.all([
    fs.rm(`${file}-wal`, { force: true }),
    fs.rm(`${file}-shm`, { force: true }),
  ]);
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

async function assertRegularDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
}

async function assertMissing(file: string): Promise<void> {
  const exists = await fs.lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (exists) throw new Error("SQLite backup destination already exists.");
}
