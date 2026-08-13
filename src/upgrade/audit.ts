import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { SqlExecutor } from "../db/sql.js";
import { isPathWithin } from "../util/paths.js";

const MANIFEST_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const AuditEntrySchema = z.object({
  keySha256: z.string().regex(SHA256_PATTERN),
  rowSha256: z.string().regex(SHA256_PATTERN),
});

const AuditDatasetSchema = z.object({
  count: z.number().int().nonnegative(),
  entries: z.array(AuditEntrySchema),
}).refine((dataset) => dataset.count === dataset.entries.length, {
  message: "dataset count does not match entry count",
});

const SessionFileSchema = z.object({
  relativePath: z.string().min(1),
  size: z.number().int().nonnegative(),
  prefixSha256: z.string().regex(SHA256_PATTERN),
});

export const UpgradeAuditManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.string().datetime(),
  databaseDialect: z.enum(["sqlite", "postgres"]),
  datasets: z.object({
    users: AuditDatasetSchema,
    threads: AuditDatasetSchema,
    messages: AuditDatasetSchema,
    files: AuditDatasetSchema,
    fileSources: AuditDatasetSchema,
    fileChunks: AuditDatasetSchema,
    messageFiles: AuditDatasetSchema,
    browserUseProfiles: AuditDatasetSchema,
    messageSearch: AuditDatasetSchema,
    chunkSearch: AuditDatasetSchema,
    embeddings: AuditDatasetSchema,
    postgresSequences: AuditDatasetSchema,
    telegramFileRefs: AuditDatasetSchema,
  }),
  piSessions: z.object({
    count: z.number().int().nonnegative(),
    files: z.array(SessionFileSchema),
  }).refine((sessions) => sessions.count === sessions.files.length, {
    message: "Pi session count does not match file count",
  }),
});

const VerificationMarkerSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  manifestSha256: z.string().regex(SHA256_PATTERN),
  verifiedAt: z.string().datetime(),
});

export type UpgradeAuditManifest = z.infer<typeof UpgradeAuditManifestSchema>;
export type UpgradeAuditSummary = {
  manifestSha256: string;
  datasets: Record<keyof UpgradeAuditManifest["datasets"], number>;
  piSessions: number;
};

type Row = Record<string, unknown>;
type DatasetName = keyof UpgradeAuditManifest["datasets"];
type DialectValue = string | Record<"sqlite" | "postgres", string>;
type DatasetDefinition = {
  name: Exclude<DatasetName, "telegramFileRefs" | "postgresSequences">;
  table: DialectValue;
  key: (row: Row) => unknown;
  query: DialectValue;
};

const DATASET_DEFINITIONS: DatasetDefinition[] = [
  {
    name: "users",
    table: "users",
    key: (row) => row.tg_id,
    query: `select tg_id, first_name, username, lang, tz_offset_min, stream_mode, created_at from users order by tg_id`,
  },
  {
    name: "threads",
    table: "threads",
    key: (row) => row.id,
    query: `select id, user_id, topic_id, parent_thread_id, fork_point_message_id, title,
      title_source, title_attempts, topic_title_synced, pi_session_file, pi_session_id,
      archived, created_at from threads order by id`,
  },
  {
    name: "messages",
    table: "messages",
    key: (row) => row.id,
    query: `select id, thread_id, role, kind, content_json, text_plain, thinking,
      tg_message_id, pi_entry_id, created_at from messages order by id`,
  },
  {
    name: "files",
    table: "files",
    key: (row) => row.id,
    query: `select id, user_id, thread_id, message_id, type, content_sha256, mime_type,
      extraction_status, name, size, content_md, summary, outline_json, is_inline,
      created_at from files order by id`,
  },
  {
    name: "fileSources",
    table: "file_sources",
    key: (row) => row.id,
    query: `select id, file_id, transport, connection_key, remote_key, locator_json,
      mime_type, last_verified_at, created_at from file_sources order by id`,
  },
  {
    name: "fileChunks",
    table: "file_chunks",
    key: (row) => row.id,
    query: `select id, file_id, idx, heading_path, content, created_at from file_chunks order by id`,
  },
  {
    name: "messageFiles",
    table: "message_files",
    key: (row) => [row.message_id, row.file_id],
    query: `select message_id, file_id, display_name, caption, created_at
      from message_files order by message_id, file_id`,
  },
  {
    name: "browserUseProfiles",
    table: "browser_use_profiles",
    key: (row) => [row.deployment_id, row.user_id],
    query: `select deployment_id, user_id, provider_user_key, profile_id, created_at, updated_at
      from browser_use_profiles order by deployment_id, user_id`,
  },
  {
    name: "messageSearch",
    table: { sqlite: "messages_fts", postgres: "message_search" },
    key: (row) => row.message_id,
    query: {
      sqlite: `select cast(message_id as integer) as message_id,
        cast(thread_id as integer) as thread_id, text
        from messages_fts order by cast(message_id as integer)`,
      postgres: `select message_id, thread_id, text, ts::text as ts
        from message_search order by message_id`,
    },
  },
  {
    name: "chunkSearch",
    table: { sqlite: "chunks_fts", postgres: "chunk_search" },
    key: (row) => row.chunk_id,
    query: {
      sqlite: `select cast(chunk_id as integer) as chunk_id,
        cast(file_id as integer) as file_id, text
        from chunks_fts order by cast(chunk_id as integer)`,
      postgres: `select chunk_id, file_id, text, ts::text as ts
        from chunk_search order by chunk_id`,
    },
  },
  {
    name: "embeddings",
    table: "embeddings",
    key: (row) => row.id,
    query: `select id, kind, ref_id, model, dim, vector, created_at
      from embeddings order by id`,
  },
];

export async function createUpgradeAuditManifest(
  db: SqlExecutor,
  piCodingAgentDir: string,
): Promise<UpgradeAuditManifest> {
  const datasets = await collectDatasets(db, "snapshot");
  const piSessions = await collectPiSessions(db, piCodingAgentDir);
  return UpgradeAuditManifestSchema.parse({
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    databaseDialect: db.dialect,
    datasets,
    piSessions,
  });
}

export async function writeUpgradeAuditManifest(
  filePath: string,
  manifest: UpgradeAuditManifest,
): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(filePath, bytes);
  return sha256(bytes);
}

export async function readUpgradeAuditManifest(filePath: string): Promise<{
  bytes: Buffer;
  manifest: UpgradeAuditManifest;
  manifestSha256: string;
}> {
  const bytes = await fs.readFile(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Upgrade audit manifest is not valid JSON: ${formatError(error)}`);
  }
  return {
    bytes,
    manifest: UpgradeAuditManifestSchema.parse(parsed),
    manifestSha256: sha256(bytes),
  };
}

export async function verifyUpgradeAuditManifest(
  db: SqlExecutor,
  piCodingAgentDir: string,
  manifest: UpgradeAuditManifest,
): Promise<UpgradeAuditSummary> {
  const current = await collectDatasets(db, "verify");
  for (const name of Object.keys(manifest.datasets) as DatasetName[]) {
    verifyDataset(name, manifest.datasets[name], current[name]);
  }
  await verifyPiSessionPrefixes(piCodingAgentDir, manifest.piSessions.files);
  return summarize(manifest, sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)));
}

export async function verifyUpgradeBaselineOnce(input: {
  db: SqlExecutor;
  piCodingAgentDir: string;
  baselineFile?: string;
  logger?: Logger;
}): Promise<{ skipped: boolean; summary?: UpgradeAuditSummary }> {
  if (!input.baselineFile?.trim()) return { skipped: true };
  const baselineFile = path.resolve(input.baselineFile);
  const piRoot = path.resolve(input.piCodingAgentDir);
  if (!isPathWithin(piRoot, baselineFile)) {
    throw new Error("UPGRADE_BASELINE_FILE must be inside PI_CODING_AGENT_DIR.");
  }
  const realPiRoot = await fs.realpath(piRoot);
  const resolvedBaseline = await resolveRegularFileWithin(realPiRoot, baselineFile);
  if (!resolvedBaseline) {
    throw new Error("UPGRADE_BASELINE_FILE must be a regular file inside PI_CODING_AGENT_DIR.");
  }
  const markerFile = `${baselineFile}.verified`;
  const markerParent = await fs.realpath(path.dirname(markerFile));
  if (!isPathWithin(realPiRoot, markerParent)) {
    throw new Error("Upgrade verification marker must be inside PI_CODING_AGENT_DIR.");
  }
  const markerStat = await fs.lstat(markerFile).catch(() => undefined);
  if (markerStat?.isSymbolicLink()) {
    throw new Error("Upgrade verification marker must not be a symbolic link.");
  }
  const loaded = await readUpgradeAuditManifest(resolvedBaseline.realPath);
  const marker = await readVerificationMarker(markerFile);
  if (marker?.manifestSha256 === loaded.manifestSha256) {
    input.logger?.info("upgrade preservation baseline already verified", {
      manifestSha256: loaded.manifestSha256,
      markerFile,
    });
    return { skipped: true, summary: summarize(loaded.manifest, loaded.manifestSha256) };
  }

  const summary = await verifyUpgradeAuditManifest(
    input.db,
    input.piCodingAgentDir,
    loaded.manifest,
  );
  summary.manifestSha256 = loaded.manifestSha256;
  await writeAtomic(markerFile, Buffer.from(`${JSON.stringify({
    version: MANIFEST_VERSION,
    manifestSha256: loaded.manifestSha256,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`));
  input.logger?.info("upgrade preservation baseline verified", {
    manifestSha256: loaded.manifestSha256,
    markerFile,
    datasets: summary.datasets,
    piSessions: summary.piSessions,
  });
  return { skipped: false, summary };
}

async function collectDatasets(
  db: SqlExecutor,
  mode: "snapshot" | "verify",
): Promise<UpgradeAuditManifest["datasets"]> {
  const result = {} as Omit<UpgradeAuditManifest["datasets"], "telegramFileRefs" | "postgresSequences">;
  for (const definition of DATASET_DEFINITIONS) {
    const table = dialectValue(definition.table, db.dialect);
    if (!(await tableExists(db, table))) {
      throw new Error(`Upgrade audit requires the ${table} table.`);
    }
    const rows = await db.query<Row>(sql.raw(dialectValue(definition.query, db.dialect)));
    result[definition.name] = datasetFromRows(definition.name, rows, definition.key);
  }
  return {
    ...result,
    postgresSequences: await collectPostgresSequences(db),
    telegramFileRefs: await collectTelegramFileRefs(db, mode),
  };
}

function dialectValue(value: DialectValue, dialect: "sqlite" | "postgres"): string {
  return typeof value === "string" ? value : value[dialect];
}

async function collectTelegramFileRefs(
  db: SqlExecutor,
  mode: "snapshot" | "verify",
): Promise<UpgradeAuditManifest["datasets"]["telegramFileRefs"]> {
  type TelegramReference = {
    fileId: unknown;
    telegramFileId: string;
    uniqueId: string | null;
    direction: string;
    mediaKind: string;
    telegramMessageId: unknown;
    width: unknown;
    height: unknown;
    telegramSize: unknown;
    isPrimary: unknown;
    firstSeenAt: unknown;
    lastSeenAt: unknown;
  };
  const references = new Map<string, TelegramReference>();
  const currentTableExists = await tableExists(db, "telegram_file_refs");
  const legacyRows = await db.query<{
    id: number;
    file_id: number;
    locator_json: string;
    mime_type: string | null;
    file_type: string;
    message_role: string | null;
    created_at: unknown;
  }>(sql`
    select s.id, s.file_id, s.locator_json, coalesce(s.mime_type, f.mime_type) as mime_type,
      f.type as file_type, m.role as message_role, s.created_at
    from file_sources s
    join files f on f.id = s.file_id
    left join messages m on m.id = f.message_id
    where s.transport = 'telegram'
    order by s.id
  `);
  for (const row of legacyRows) {
    const locator = parseTelegramLocator(row.id, row.locator_json);
    if (mode === "snapshot" || !currentTableExists) {
      const key = stableJson([row.file_id, locator.fileId]);
      references.set(key, {
        fileId: row.file_id,
        telegramFileId: locator.fileId,
        uniqueId: locator.uniqueId,
        direction: row.message_role === "assistant" ? "outbound" : "inbound",
        mediaKind: row.file_type === "image" && row.mime_type === "image/jpeg" ? "photo" : "document",
        telegramMessageId: null,
        width: null,
        height: null,
        telegramSize: null,
        isPrimary: 1,
        firstSeenAt: row.created_at,
        lastSeenAt: row.created_at,
      });
    }
  }

  if (mode === "verify" && !currentTableExists) {
    throw new Error("Upgrade audit verification requires the migrated telegram_file_refs table.");
  }
  if (currentTableExists) {
    const rows = await db.query<{
      file_id: number;
      telegram_file_id: string;
      telegram_file_unique_id: string | null;
      direction: string;
      media_kind: string;
      telegram_message_id: unknown;
      width: unknown;
      height: unknown;
      telegram_size: unknown;
      is_primary: unknown;
      first_seen_at: unknown;
      last_seen_at: unknown;
    }>(sql`
      select file_id, telegram_file_id, telegram_file_unique_id, direction, media_kind,
        telegram_message_id, width, height, telegram_size, is_primary, first_seen_at, last_seen_at
      from telegram_file_refs
      order by file_id, telegram_file_id
    `);
    for (const row of rows) {
      const telegramFileId = row.telegram_file_id.trim();
      if (!telegramFileId) throw new Error("Upgrade audit found an empty telegram_file_refs.telegram_file_id.");
      const key = stableJson([row.file_id, telegramFileId]);
      references.set(key, {
        fileId: row.file_id,
        telegramFileId,
        uniqueId: row.telegram_file_unique_id?.trim() || null,
        direction: row.direction,
        mediaKind: row.media_kind,
        telegramMessageId: row.telegram_message_id,
        width: row.width,
        height: row.height,
        telegramSize: row.telegram_size,
        isPrimary: row.is_primary,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      });
    }
  }

  const rows = [...references.values()].sort((left, right) =>
    stableJson([left.fileId, left.telegramFileId]).localeCompare(stableJson([right.fileId, right.telegramFileId])));
  return datasetFromRows("telegramFileRefs", rows, (row) => [row.fileId, row.telegramFileId]);
}

async function collectPostgresSequences(
  db: SqlExecutor,
): Promise<UpgradeAuditManifest["datasets"]["postgresSequences"]> {
  if (db.dialect === "sqlite") return { count: 0, entries: [] };
  const sequences = await db.query<{
    sequence_schema_name: string;
    table_schema_name: string;
    table_name: string;
    column_name: string;
    sequence_name: string;
    increment_by: string;
  }>(sql`
    select sequence_ns.nspname as sequence_schema_name, table_ns.nspname as table_schema_name,
      table_class.relname as table_name,
      table_attr.attname as column_name, sequence_class.relname as sequence_name,
      sequence_data.seqincrement::text as increment_by
    from pg_class sequence_class
    join pg_namespace sequence_ns on sequence_ns.oid = sequence_class.relnamespace
    join pg_sequence sequence_data on sequence_data.seqrelid = sequence_class.oid
    join pg_depend dependency on dependency.objid = sequence_class.oid
      and dependency.classid = 'pg_class'::regclass
      and dependency.refclassid = 'pg_class'::regclass
      and dependency.deptype in ('a', 'i')
    join pg_class table_class on table_class.oid = dependency.refobjid
    join pg_namespace table_ns on table_ns.oid = table_class.relnamespace
    join pg_attribute table_attr on table_attr.attrelid = table_class.oid
      and table_attr.attnum = dependency.refobjsubid
    where sequence_class.relkind = 'S'
      and sequence_ns.nspname = current_schema()
      and table_ns.nspname = current_schema()
    order by table_class.relname, table_attr.attname
  `);
  const rows: Row[] = [];
  for (const sequence of sequences) {
    const qualifiedSequence = pgQualifiedName(sequence.sequence_schema_name, sequence.sequence_name);
    const qualifiedTable = pgQualifiedName(sequence.table_schema_name, sequence.table_name);
    const column = pgIdentifier(sequence.column_name);
    const [state] = await db.query<{ last_value: string; is_called: boolean }>(sql.raw(
      `select last_value::text as last_value, is_called from ${qualifiedSequence}`,
    ));
    const [maximum] = await db.query<{ maximum_value: string | null }>(sql.raw(
      `select max(${column})::text as maximum_value from ${qualifiedTable}`,
    ));
    if (!state) throw new Error(`Upgrade audit could not read PostgreSQL sequence ${sequence.sequence_name}.`);
    const increment = BigInt(sequence.increment_by);
    const lastValue = BigInt(state.last_value);
    const nextValue = state.is_called ? lastValue + increment : lastValue;
    const maximumValue = maximum?.maximum_value === null || maximum?.maximum_value === undefined
      ? null
      : BigInt(maximum.maximum_value);
    if (increment <= 0n || (maximumValue !== null && nextValue <= maximumValue)) {
      throw new Error(`Upgrade audit found unsafe PostgreSQL sequence ${sequence.sequence_name}.`);
    }
    rows.push({
      sequenceSchemaName: sequence.sequence_schema_name,
      tableSchemaName: sequence.table_schema_name,
      tableName: sequence.table_name,
      columnName: sequence.column_name,
      sequenceName: sequence.sequence_name,
      lastValue: state.last_value,
      isCalled: state.is_called,
      incrementBy: sequence.increment_by,
      maximumValue: maximum?.maximum_value ?? null,
    });
  }
  return datasetFromRows(
    "postgresSequences",
    rows,
    (row) => [row.sequenceSchemaName, row.tableSchemaName, row.tableName, row.columnName, row.sequenceName],
  );
}

function pgIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function pgQualifiedName(schema: string, relation: string): string {
  return `${pgIdentifier(schema)}.${pgIdentifier(relation)}`;
}

async function collectPiSessions(
  db: SqlExecutor,
  piCodingAgentDir: string,
): Promise<UpgradeAuditManifest["piSessions"]> {
  const rows = await db.query<{ id: number; pi_session_file: string | null }>(sql`
    select id, pi_session_file from threads
    where pi_session_file is not null
    order by id
  `);
  const root = path.resolve(piCodingAgentDir);
  const realRoot = await fs.realpath(root);
  const uniqueFiles = new Map<string, string>();
  for (const row of rows) {
    const sessionPath = path.resolve(row.pi_session_file!);
    if (!isPathWithin(root, sessionPath)) {
      throw new Error(`Pi session for audited thread key ${opaqueKey("thread", row.id)} is outside PI_CODING_AGENT_DIR.`);
    }
    const relativePath = path.relative(root, sessionPath);
    if (!relativePath) {
      throw new Error(`Pi session for audited thread key ${opaqueKey("thread", row.id)} points at PI_CODING_AGENT_DIR itself.`);
    }
    uniqueFiles.set(relativePath, sessionPath);
  }

  const files: UpgradeAuditManifest["piSessions"]["files"] = [];
  for (const [relativePath, sessionPath] of [...uniqueFiles].sort(([left], [right]) => left.localeCompare(right))) {
    const resolved = await resolveRegularFileWithin(realRoot, sessionPath);
    if (!resolved) throw new Error(`Referenced Pi session is missing or unsafe: ${relativePath}`);
    files.push({
      relativePath,
      size: resolved.size,
      prefixSha256: await sha256FilePrefix(resolved.realPath, resolved.size),
    });
  }
  return { count: files.length, files };
}

async function verifyPiSessionPrefixes(
  piCodingAgentDir: string,
  files: UpgradeAuditManifest["piSessions"]["files"],
): Promise<void> {
  const root = path.resolve(piCodingAgentDir);
  const realRoot = await fs.realpath(root);
  for (const baseline of files) {
    const sessionPath = path.resolve(root, baseline.relativePath);
    if (!isPathWithin(root, sessionPath) || path.relative(root, sessionPath) !== baseline.relativePath) {
      throw new Error("Upgrade audit manifest contains an unsafe Pi session path.");
    }
    const resolved = await resolveRegularFileWithin(realRoot, sessionPath);
    if (!resolved) throw new Error(`Preserved Pi session is missing or unsafe: ${baseline.relativePath}`);
    if (resolved.size < baseline.size) {
      throw new Error(`Preserved Pi session was truncated: ${baseline.relativePath}`);
    }
    const currentPrefix = await sha256FilePrefix(resolved.realPath, baseline.size);
    if (currentPrefix !== baseline.prefixSha256) {
      throw new Error(`Preserved Pi session prefix changed: ${baseline.relativePath}`);
    }
  }
}

function datasetFromRows(
  name: DatasetName,
  rows: Row[],
  key: (row: Row) => unknown,
): UpgradeAuditManifest["datasets"][DatasetName] {
  const entries = rows.map((row) => ({
    keySha256: opaqueKey(name, key(row)),
    rowSha256: digest(`${name}:row`, row),
  })).sort((left, right) => left.keySha256.localeCompare(right.keySha256));
  const keys = new Set(entries.map((entry) => entry.keySha256));
  if (keys.size !== entries.length) throw new Error(`Upgrade audit found duplicate ${name} record keys.`);
  return { count: entries.length, entries };
}

function verifyDataset(
  name: DatasetName,
  baseline: UpgradeAuditManifest["datasets"][DatasetName],
  current: UpgradeAuditManifest["datasets"][DatasetName],
): void {
  if (current.count < baseline.count) {
    throw new Error(`Upgrade audit failed: ${name} count fell from ${baseline.count} to ${current.count}.`);
  }
  const currentByKey = new Map(current.entries.map((entry) => [entry.keySha256, entry.rowSha256]));
  for (const expected of baseline.entries) {
    const actual = currentByKey.get(expected.keySha256);
    if (!actual) throw new Error(`Upgrade audit failed: a baseline ${name} record is missing (${expected.keySha256}).`);
    if (actual !== expected.rowSha256) {
      throw new Error(`Upgrade audit failed: a baseline ${name} record changed (${expected.keySha256}).`);
    }
  }
}

function parseTelegramLocator(sourceId: number, locatorJson: string): { fileId: string; uniqueId: string | null } {
  let locator: unknown;
  try {
    locator = JSON.parse(locatorJson);
  } catch (error) {
    throw new Error(`Telegram source ${opaqueKey("file-source", sourceId)} has malformed locator JSON: ${formatError(error)}`);
  }
  if (!locator || typeof locator !== "object") {
    throw new Error(`Telegram source ${opaqueKey("file-source", sourceId)} has a non-object locator.`);
  }
  const record = locator as Record<string, unknown>;
  const fileId = typeof record.file_id === "string" ? record.file_id.trim() : "";
  if (!fileId) throw new Error(`Telegram source ${opaqueKey("file-source", sourceId)} has no file_id.`);
  return {
    fileId,
    uniqueId: typeof record.file_unique_id === "string" ? record.file_unique_id.trim() || null : null,
  };
}

async function tableExists(db: SqlExecutor, table: string): Promise<boolean> {
  if (db.dialect === "sqlite") {
    const rows = await db.query<{ name: string }>(sql`
      select name from sqlite_master where type = 'table' and name = ${table}
    `);
    return rows.length > 0;
  }
  const rows = await db.query<{ exists: boolean }>(sql`
    select exists(
      select 1 from information_schema.tables
      where table_schema = current_schema() and table_name = ${table}
    ) as exists
  `);
  return Boolean(rows[0]?.exists);
}

async function resolveRegularFileWithin(
  realRoot: string,
  filePath: string,
): Promise<{ realPath: string; size: number } | undefined> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return undefined;
  const realPath = await fs.realpath(filePath).catch(() => undefined);
  if (!realPath || !isPathWithin(realRoot, realPath)) return undefined;
  const realStat = await fs.stat(realPath).catch(() => undefined);
  if (!realStat?.isFile()) return undefined;
  return { realPath, size: realStat.size };
}

async function sha256FilePrefix(filePath: string, size: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (!bytesRead) throw new Error(`File ended before the audited prefix: ${filePath}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function readVerificationMarker(filePath: string): Promise<z.infer<typeof VerificationMarkerSchema> | undefined> {
  const text = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  try {
    return VerificationMarkerSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

async function writeAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, resolved);
    await fs.chmod(resolved, 0o600);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function summarize(manifest: UpgradeAuditManifest, manifestSha256: string): UpgradeAuditSummary {
  return {
    manifestSha256,
    datasets: Object.fromEntries(
      Object.entries(manifest.datasets).map(([name, dataset]) => [name, dataset.count]),
    ) as UpgradeAuditSummary["datasets"],
    piSessions: manifest.piSessions.count,
  };
}

function opaqueKey(domain: string, key: unknown): string {
  return digest(`${domain}:key`, key);
}

function digest(domain: string, value: unknown): string {
  return sha256(Buffer.from(`${domain}\0${stableJson(value)}`));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

function normalizeStable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (value instanceof Uint8Array) return { $buffer: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(normalizeStable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeStable(entry)]),
    );
  }
  return value ?? null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
