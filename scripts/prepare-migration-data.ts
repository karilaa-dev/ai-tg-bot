import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createDatabase } from "../src/db/index.js";

export async function prepareMigrationData(appDataDirectory: string): Promise<{
  appDataRoot: string;
  databaseFile: string;
  piDirectory: string;
}> {
  const appDataRoot = path.resolve(appDataDirectory);
  const databaseFile = path.join(appDataRoot, "bot.db");
  const piDirectory = path.join(appDataRoot, "pi");

  await assertRegularDirectory(appDataRoot, "application data directory");
  await assertRegularFile(databaseFile, "SQLite database");
  await assertRegularDirectory(piDirectory, "Pi directory");

  await Promise.all([
    fs.rm(path.join(piDirectory, "upgrade-baseline.json"), { force: true }),
    fs.rm(path.join(piDirectory, "upgrade-baseline.json.verified"), { force: true }),
  ]);

  const database = createDatabase({ DB_URL: `sqlite:${databaseFile}` });
  try {
    await database.initialize();
  } finally {
    await database.destroy();
  }

  await normalizeAndVerify(databaseFile);
  return { appDataRoot, databaseFile, piDirectory };
}

if (isMainModule()) {
  if (process.getuid?.() === 0) {
    throw new Error("Migration data preparation must run as the non-root application user.");
  }
  const result = await prepareMigrationData(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ status: "migration-data-prepared", ...result })}\n`);
}

function parseArguments(args: string[]): string {
  const [flag, directory, ...rest] = args;
  if (flag !== "--data" || !directory || rest.length) {
    throw new Error("Usage: node dist/scripts/prepare-migration-data.js --data <app-data-directory>");
  }
  return path.resolve(directory);
}

async function normalizeAndVerify(file: string): Promise<void> {
  const sqlite = new Database(file, { fileMustExist: true });
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const journalMode = sqlite.pragma("journal_mode = delete", { simple: true });
    if (journalMode !== "delete") throw new Error("Prepared SQLite database could not leave WAL journal mode.");
    const rows = sqlite.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] || {})[0] !== "ok") {
      throw new Error("Prepared SQLite database failed integrity_check.");
    }
  } finally {
    sqlite.close();
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

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && path.resolve(entrypoint) === fileURLToPath(import.meta.url));
}
