import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import pg from "pg";
import { createDatabase, type AppDatabase } from "../db/index.js";
import {
  verifyUpgradeBaselineOnce,
  type UpgradeAuditSummary,
} from "./audit.js";
import { isPathWithin } from "../util/paths.js";

const DUMP_FILE = "aibot.dump";
const PI_ARCHIVE_FILE = "pi-home.tgz";
const CHECKSUM_FILE = "SHA256SUMS";
const STATE_FILE = ".upgrade-import-state.json";
const MAX_COMMAND_ERROR_CHARS = 16_000;

export interface UpgradeImportInput {
  artifactsDir: string;
  dbUrl: string;
  piCodingAgentDir: string;
  baselineFile: string;
  botToken: string;
  e2bDeploymentId: string;
  browserUseDeploymentId: string;
  onEvent?: (event: UpgradeImportEvent) => void;
  dependencies?: Partial<UpgradeImportDependencies>;
}

export interface UpgradeImportEvent {
  event: string;
  [key: string]: unknown;
}

interface UpgradeImportDependencies {
  assertDatabaseEmpty(dbUrl: string): Promise<void>;
  inspectPiArchive(
    archivePath: string,
    expectedBaselinePath: string,
    forbiddenMarkerPath: string,
  ): Promise<void>;
  runCommand(command: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<void>;
  createDatabase(config: { DB_URL: string }): AppDatabase;
  verifyBaseline: typeof verifyUpgradeBaselineOnce;
}

interface ArtifactPaths {
  dump: string;
  piArchive: string;
  sha256: Record<typeof DUMP_FILE | typeof PI_ARCHIVE_FILE, string>;
}

export interface UpgradeImportResult {
  status: "import-complete";
  manifestSha256: string;
  summary: UpgradeAuditSummary;
  artifacts: Record<typeof DUMP_FILE | typeof PI_ARCHIVE_FILE, string>;
}

export async function runUpgradeImport(input: UpgradeImportInput): Promise<UpgradeImportResult> {
  const dependencies: UpgradeImportDependencies = {
    assertDatabaseEmpty: assertPostgresDatabaseEmpty,
    inspectPiArchive,
    runCommand,
    createDatabase,
    verifyBaseline: verifyUpgradeBaselineOnce,
    ...input.dependencies,
  };
  const emit = input.onEvent || (() => undefined);
  if (!input.botToken.trim()) throw new Error("BOT_TOKEN is required for offline import verification.");
  const postgres = parsePostgresUrl(input.dbUrl);
  const artifactsDir = path.resolve(input.artifactsDir);
  const piRoot = path.resolve(input.piCodingAgentDir);
  if (pathsOverlap(artifactsDir, piRoot)) {
    throw new Error("Upgrade import source and PI_CODING_AGENT_DIR must be separate directories.");
  }
  const baselineFile = path.resolve(input.baselineFile);
  const baselineRelativePath = path.relative(piRoot, baselineFile);
  if (!isSafeRelativePath(baselineRelativePath)) {
    throw new Error("UPGRADE_BASELINE_FILE must be a file inside PI_CODING_AGENT_DIR.");
  }

  await assertRegularDirectory(artifactsDir, "Upgrade import source");
  const stateFile = path.join(artifactsDir, STATE_FILE);
  await assertNoImportState(stateFile);
  const artifacts = await validateArtifacts(artifactsDir);
  await dependencies.runCommand("pg_restore", ["--list", artifacts.dump]);
  await dependencies.inspectPiArchive(
    artifacts.piArchive,
    baselineRelativePath,
    `${baselineRelativePath}.verified`,
  );
  emit({ event: "upgrade import artifacts verified", artifacts: artifacts.sha256 });

  await dependencies.assertDatabaseEmpty(input.dbUrl);
  await assertEmptyDirectory(piRoot);
  emit({ event: "upgrade import destinations verified empty" });

  await writeImportState(stateFile, {
    version: 1,
    status: "started",
    startedAt: new Date().toISOString(),
    artifacts: artifacts.sha256,
  }, true);

  try {
    await dependencies.runCommand("pg_restore", [
      "--dbname", postgres.database,
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      artifacts.dump,
    ], postgres.environment);
    emit({ event: "upgrade import PostgreSQL dump restored" });

    await dependencies.runCommand("tar", [
      "--extract",
      "--gzip",
      "--file", artifacts.piArchive,
      "--directory", piRoot,
      "--no-same-owner",
      "--no-same-permissions",
      "--delay-directory-restore",
    ]);
    await assertRegularFile(baselineFile, "restored upgrade baseline");
    await assertMissing(`${baselineFile}.verified`, "The Pi archive contains a stale verification marker.");
    emit({ event: "upgrade import Pi archive restored" });

    const database = dependencies.createDatabase({ DB_URL: input.dbUrl });
    try {
      await database.initialize();
      emit({ event: "upgrade import schema migrated" });
      const verification = await dependencies.verifyBaseline({
        db: database.db,
        piCodingAgentDir: piRoot,
        botToken: input.botToken,
        e2bDeploymentId: input.e2bDeploymentId,
        browserUseDeploymentId: input.browserUseDeploymentId,
        baselineFile,
      });
      if (verification.skipped || !verification.summary) {
        throw new Error("Offline import verification unexpectedly skipped the restored baseline.");
      }
      const markerFile = `${baselineFile}.verified`;
      await assertRegularFile(markerFile, "upgrade verification marker");
      const result: UpgradeImportResult = {
        status: "import-complete",
        manifestSha256: verification.summary.manifestSha256,
        summary: verification.summary,
        artifacts: artifacts.sha256,
      };
      await writeImportState(stateFile, {
        version: 1,
        status: "complete",
        completedAt: new Date().toISOString(),
        manifestSha256: result.manifestSha256,
        artifacts: artifacts.sha256,
      });
      emit({
        event: "upgrade import verification complete",
        manifestSha256: result.manifestSha256,
        datasets: result.summary.datasets,
        piSessions: result.summary.piSessions,
        piStateFiles: result.summary.piStateFiles,
        markerFile,
      });
      return result;
    } finally {
      await database.destroy();
    }
  } catch (error) {
    await writeImportState(stateFile, {
      version: 1,
      status: "failed",
      failedAt: new Date().toISOString(),
      message: formatError(error),
      artifacts: artifacts.sha256,
    }).catch(() => undefined);
    throw error;
  }
}

async function validateArtifacts(artifactsDir: string): Promise<ArtifactPaths> {
  const dump = path.join(artifactsDir, DUMP_FILE);
  const piArchive = path.join(artifactsDir, PI_ARCHIVE_FILE);
  const checksumFile = path.join(artifactsDir, CHECKSUM_FILE);
  await Promise.all([
    assertRegularFile(dump, DUMP_FILE),
    assertRegularFile(piArchive, PI_ARCHIVE_FILE),
    assertRegularFile(checksumFile, CHECKSUM_FILE),
  ]);
  const allowed = new Set([DUMP_FILE, PI_ARCHIVE_FILE, CHECKSUM_FILE, STATE_FILE]);
  for (const entry of await fs.readdir(artifactsDir)) {
    if (!allowed.has(entry)) {
      throw new Error(`Upgrade import source contains an unexpected filename: ${entry}`);
    }
  }
  const expected = parseChecksumManifest(await fs.readFile(checksumFile, "utf8"));
  const [dumpSha256, piArchiveSha256] = await Promise.all([
    sha256File(dump),
    sha256File(piArchive),
  ]);
  if (dumpSha256 !== expected[DUMP_FILE]) throw new Error(`${DUMP_FILE} checksum does not match SHA256SUMS.`);
  if (piArchiveSha256 !== expected[PI_ARCHIVE_FILE]) {
    throw new Error(`${PI_ARCHIVE_FILE} checksum does not match SHA256SUMS.`);
  }
  return {
    dump,
    piArchive,
    sha256: { [DUMP_FILE]: dumpSha256, [PI_ARCHIVE_FILE]: piArchiveSha256 },
  };
}

export function parseChecksumManifest(contents: string): Record<typeof DUMP_FILE | typeof PI_ARCHIVE_FILE, string> {
  const checksums = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})[ \t]+[*]?([^\s]+)$/u.exec(line);
    if (!match) throw new Error("SHA256SUMS contains a malformed line.");
    const [, checksum, filename] = match;
    if (filename !== DUMP_FILE && filename !== PI_ARCHIVE_FILE) {
      throw new Error(`SHA256SUMS contains an unexpected filename: ${filename}`);
    }
    if (checksums.has(filename)) throw new Error(`SHA256SUMS contains a duplicate filename: ${filename}`);
    checksums.set(filename, checksum.toLowerCase());
  }
  for (const filename of [DUMP_FILE, PI_ARCHIVE_FILE] as const) {
    if (!checksums.has(filename)) throw new Error(`SHA256SUMS is missing ${filename}.`);
  }
  return Object.fromEntries(checksums) as Record<typeof DUMP_FILE | typeof PI_ARCHIVE_FILE, string>;
}

async function inspectPiArchive(
  archivePath: string,
  expectedBaselinePath: string,
  forbiddenMarkerPath: string,
): Promise<void> {
  let foundBaseline = false;
  let entries = 0;
  const entryTypes: string[] = [];
  await streamCommandLines(
    "tar",
    ["--list", "--verbose", "--gzip", "--file", archivePath],
    (entry) => {
      const type = entry[0];
      if (type !== "-" && type !== "d") {
        throw new Error("pi-home.tgz contains a non-regular file or symbolic link.");
      }
      entryTypes.push(type);
    },
  );
  const seen = new Set<string>();
  await streamCommandLines("tar", ["--list", "--gzip", "--file", archivePath], (entry) => {
    const type = entryTypes[entries];
    if (!type) throw new Error("pi-home.tgz produced inconsistent archive listings.");
    entries += 1;
    const normalized = normalizeArchivePath(entry);
    if (seen.has(normalized)) throw new Error("pi-home.tgz contains a duplicate archive path.");
    seen.add(normalized);
    if (normalized === forbiddenMarkerPath) {
      throw new Error("pi-home.tgz contains a stale verification marker.");
    }
    if (normalized === expectedBaselinePath) {
      if (type !== "-") throw new Error(`${expectedBaselinePath} must be a regular file in pi-home.tgz.`);
      foundBaseline = true;
    }
  });
  if (!entries) throw new Error("pi-home.tgz is empty.");
  if (entries !== entryTypes.length) throw new Error("pi-home.tgz produced inconsistent archive listings.");
  if (!foundBaseline) throw new Error(`pi-home.tgz does not contain ${expectedBaselinePath}.`);
}

function normalizeArchivePath(entry: string): string {
  let normalized = entry;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized || normalized === ".") return "";
  if (!isSafeRelativePath(normalized)) throw new Error("pi-home.tgz contains an unsafe path.");
  return normalized;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function assertPostgresDatabaseEmpty(dbUrl: string): Promise<void> {
  parsePostgresUrl(dbUrl);
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(`
      select count(*)::text as count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
        and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    `);
    if (Number(result.rows[0]?.count || 0) !== 0) {
      throw new Error("Target PostgreSQL database is not empty.");
    }
  } finally {
    await client.end();
  }
}

function parsePostgresUrl(dbUrl: string): { database: string; environment: NodeJS.ProcessEnv } {
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error("DB_URL must be a valid PostgreSQL URL for offline import.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Offline import requires a PostgreSQL DB_URL.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!parsed.hostname || !parsed.username || !database) {
    throw new Error("DB_URL must include PostgreSQL host, user, and database name.");
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database,
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) environment.PGSSLMODE = sslMode;
  return { database, environment };
}

async function assertEmptyDirectory(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath).catch(() => undefined);
  if (!stat) {
    throw new Error("Target Pi volume directory does not exist.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("PI_CODING_AGENT_DIR must be a regular directory.");
  }
  const entries = await fs.readdir(directoryPath);
  if (entries.length) throw new Error("Target Pi volume is not empty.");
}

async function assertRegularDirectory(directoryPath: string, label: string): Promise<void> {
  const stat = await fs.lstat(directoryPath).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory.`);
  }
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

async function assertMissing(filePath: string, message: string): Promise<void> {
  const exists = await fs.lstat(filePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (exists) throw new Error(message);
}

async function assertNoImportState(stateFile: string): Promise<void> {
  await assertMissing(
    stateFile,
    "This import directory already contains an upgrade attempt state; recreate both target resources before retrying.",
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

async function writeImportState(stateFile: string, value: object, exclusive = false): Promise<void> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    await fs.writeFile(stateFile, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporary, stateFile);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function runCommand(command: string, args: string[], environment = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_COMMAND_ERROR_CHARS) stderr += chunk.slice(0, MAX_COMMAND_ERROR_CHARS - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} failed (${signal || code}): ${stderr.trim() || "no error output"}`));
    });
  });
}

async function streamCommandLines(
  command: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} failed (${signal || code}): ${stderr.trim() || "no error output"}`));
    });
  });
  void completion.catch(() => undefined);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_COMMAND_ERROR_CHARS) stderr += chunk.slice(0, MAX_COMMAND_ERROR_CHARS - stderr.length);
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) onLine(line);
  } catch (error) {
    child.kill("SIGTERM");
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
