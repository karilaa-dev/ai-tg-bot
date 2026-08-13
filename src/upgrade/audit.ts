import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { SqlExecutor } from "../db/sql.js";
import { isPathWithin } from "../util/paths.js";

const MANIFEST_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATASET_BATCH_SIZE = 64;

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

const PiStateFileSchema = z.object({
  relativePath: z.enum(["auth.json", "models.json", "settings.json"]),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256_PATTERN),
});

export const UpgradeAuditManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.string().datetime(),
  databaseDialect: z.enum(["sqlite", "postgres"]),
  telegramBotIdentitySha256: z.string().regex(SHA256_PATTERN),
  e2bDeploymentIdentitySha256: z.string().regex(SHA256_PATTERN),
  browserUseDeploymentIdentitySha256: z.string().regex(SHA256_PATTERN),
  datasets: z.object({
    users: AuditDatasetSchema,
    threads: AuditDatasetSchema,
    threadSandboxes: AuditDatasetSchema,
    messages: AuditDatasetSchema,
    files: AuditDatasetSchema,
    fileSources: AuditDatasetSchema,
    fileChunks: AuditDatasetSchema,
    messageFiles: AuditDatasetSchema,
    browserUseProfiles: AuditDatasetSchema,
    sandboxFileRestoreStatus: AuditDatasetSchema,
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
  piState: z.object({
    count: z.number().int().nonnegative(),
    files: z.array(PiStateFileSchema),
  }).refine((state) => state.count === state.files.length, {
    message: "Pi state count does not match file count",
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
  piStateFiles: number;
};

type Row = Record<string, unknown>;
type DatasetName = keyof UpgradeAuditManifest["datasets"];
type StandardDatasetName = Exclude<DatasetName, "telegramFileRefs" | "postgresSequences">;
type DialectValue = string | Record<"sqlite" | "postgres", string>;
type AuditHasher = {
  digest: (domain: string, value: unknown) => string;
  filePrefix: (filePath: string, size: number) => Promise<string>;
};
type DatasetDefinition<Name extends DatasetName = DatasetName> = {
  name: Name;
  table: DialectValue;
  key: (row: Row) => unknown;
  query: DialectValue;
  pageColumns: readonly string[];
  snapshotOptional?: boolean;
};

const DATASET_DEFINITIONS: DatasetDefinition<StandardDatasetName>[] = [
  {
    name: "users",
    table: "users",
    key: (row) => row.tg_id,
    query: `select tg_id, first_name, username, lang, tz_offset_min, stream_mode, created_at from users`,
    pageColumns: ["tg_id"],
  },
  {
    name: "threads",
    table: "threads",
    key: (row) => row.id,
    query: `select id, user_id, topic_id, parent_thread_id, fork_point_message_id, title,
      title_source, title_attempts, topic_title_synced, pi_session_file, pi_session_id,
      archived, created_at from threads`,
    pageColumns: ["id"],
  },
  {
    name: "threadSandboxes",
    table: "thread_sandboxes",
    key: (row) => [row.deployment_id, row.thread_id],
    query: `select deployment_id, user_id, thread_id, sandbox_id, created_at, updated_at
      from thread_sandboxes`,
    pageColumns: ["deployment_id", "thread_id"],
    snapshotOptional: true,
  },
  {
    name: "messages",
    table: "messages",
    key: (row) => row.id,
    query: `select id, thread_id, role, kind, content_json, text_plain, thinking,
      tg_message_id, pi_entry_id, created_at from messages`,
    pageColumns: ["id"],
  },
  {
    name: "files",
    table: "files",
    key: (row) => row.id,
    query: `select id, user_id, thread_id, message_id, type, content_sha256, mime_type,
      extraction_status, name, size, content_md, summary, outline_json, is_inline,
      created_at from files`,
    pageColumns: ["id"],
  },
  {
    name: "fileSources",
    table: "file_sources",
    key: (row) => row.id,
    query: `select id, file_id, transport, connection_key, remote_key, locator_json,
      mime_type, last_verified_at, created_at from file_sources`,
    pageColumns: ["id"],
  },
  {
    name: "fileChunks",
    table: "file_chunks",
    key: (row) => row.id,
    query: `select id, file_id, idx, heading_path, content, created_at from file_chunks`,
    pageColumns: ["id"],
  },
  {
    name: "messageFiles",
    table: "message_files",
    key: (row) => [row.message_id, row.file_id],
    query: `select message_id, file_id, display_name, caption, created_at
      from message_files`,
    pageColumns: ["message_id", "file_id"],
  },
  {
    name: "browserUseProfiles",
    table: "browser_use_profiles",
    key: (row) => [row.deployment_id, row.user_id],
    query: `select deployment_id, user_id, provider_user_key, profile_id, created_at, updated_at
      from browser_use_profiles`,
    pageColumns: ["deployment_id", "user_id"],
    snapshotOptional: true,
  },
  {
    name: "sandboxFileRestoreStatus",
    table: "sandbox_file_restore_status",
    key: (row) => [row.deployment_id, row.sandbox_id, row.file_id],
    query: `select deployment_id, thread_id, sandbox_id, file_id, telegram_file_ref_id,
      sandbox_name, status, restored_size, restored_sha256, error_code, error_detail,
      attempted_at, completed_at
      from sandbox_file_restore_status`,
    pageColumns: ["deployment_id", "sandbox_id", "file_id"],
    snapshotOptional: true,
  },
  {
    name: "messageSearch",
    table: { sqlite: "messages_fts", postgres: "message_search" },
    key: (row) => row.message_id,
    query: {
      sqlite: `select cast(message_id as integer) as message_id,
        cast(thread_id as integer) as thread_id, text
        from messages_fts`,
      postgres: `select message_id, thread_id, text, ts::text as ts
        from message_search`,
    },
    pageColumns: ["message_id"],
  },
  {
    name: "chunkSearch",
    table: { sqlite: "chunks_fts", postgres: "chunk_search" },
    key: (row) => row.chunk_id,
    query: {
      sqlite: `select cast(chunk_id as integer) as chunk_id,
        cast(file_id as integer) as file_id, text
        from chunks_fts`,
      postgres: `select chunk_id, file_id, text, ts::text as ts
        from chunk_search`,
    },
    pageColumns: ["chunk_id"],
  },
  {
    name: "embeddings",
    table: "embeddings",
    key: (row) => row.id,
    query: `select id, kind, ref_id, model, dim, vector, created_at
      from embeddings`,
    pageColumns: ["id"],
  },
];

const PI_STATE_FILES = ["auth.json", "models.json", "settings.json"] as const;

const TELEGRAM_FILE_REFS_DEFINITION: DatasetDefinition<"telegramFileRefs"> = {
  name: "telegramFileRefs",
  table: "telegram_file_refs",
  key: (row) => [row.fileId, row.telegramFileId],
  query: `select file_id as "fileId", trim(telegram_file_id) as "telegramFileId",
    nullif(trim(telegram_file_unique_id), '') as "uniqueId", direction, media_kind as "mediaKind",
    telegram_message_id as "telegramMessageId", width, height, telegram_size as "telegramSize",
    is_primary as "isPrimary", first_seen_at as "firstSeenAt", last_seen_at as "lastSeenAt"
    from telegram_file_refs`,
  pageColumns: ["fileId", "telegramFileId"],
};

export async function createUpgradeAuditManifest(
  db: SqlExecutor,
  piCodingAgentDir: string,
  botToken: string,
  e2bDeploymentId: string,
  browserUseDeploymentId: string,
): Promise<UpgradeAuditManifest> {
  const hasher = createAuditHasher(botToken);
  const datasets = await collectDatasets(db, "snapshot", hasher);
  const piSessions = await collectPiSessions(db, piCodingAgentDir, hasher);
  const piState = await collectPiStateFiles(piCodingAgentDir, hasher);
  return UpgradeAuditManifestSchema.parse({
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    databaseDialect: db.dialect,
    telegramBotIdentitySha256: telegramBotIdentitySha256(botToken, hasher),
    e2bDeploymentIdentitySha256: e2bDeploymentIdentitySha256(e2bDeploymentId, hasher),
    browserUseDeploymentIdentitySha256: browserUseDeploymentIdentitySha256(browserUseDeploymentId, hasher),
    datasets,
    piSessions,
    piState,
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
  options: {
    botToken: string;
    e2bDeploymentId: string;
    browserUseDeploymentId: string;
    requireExactDatasets?: boolean;
  },
): Promise<UpgradeAuditSummary> {
  const hasher = createAuditHasher(options.botToken);
  verifyTelegramBotIdentity(options.botToken, manifest.telegramBotIdentitySha256, hasher);
  verifyE2bDeploymentIdentity(options.e2bDeploymentId, manifest.e2bDeploymentIdentitySha256, hasher);
  verifyBrowserUseDeploymentIdentity(
    options.browserUseDeploymentId,
    manifest.browserUseDeploymentIdentitySha256,
    hasher,
  );
  await verifyDatasets(
    db,
    manifest.datasets,
    Boolean(options.requireExactDatasets),
    hasher,
  );
  await verifyPiSessionPrefixes(piCodingAgentDir, manifest.piSessions.files, hasher);
  await verifyPiStateFiles(piCodingAgentDir, manifest.piState.files, hasher);
  return summarize(manifest, sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)));
}

export async function verifyUpgradeBaselineOnce(input: {
  db: SqlExecutor;
  piCodingAgentDir: string;
  botToken: string;
  e2bDeploymentId: string;
  browserUseDeploymentId: string;
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
  const hasher = createAuditHasher(input.botToken);
  verifyTelegramBotIdentity(input.botToken, loaded.manifest.telegramBotIdentitySha256, hasher);
  verifyE2bDeploymentIdentity(
    input.e2bDeploymentId,
    loaded.manifest.e2bDeploymentIdentitySha256,
    hasher,
  );
  verifyBrowserUseDeploymentIdentity(
    input.browserUseDeploymentId,
    loaded.manifest.browserUseDeploymentIdentitySha256,
    hasher,
  );
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
    {
      botToken: input.botToken,
      e2bDeploymentId: input.e2bDeploymentId,
      browserUseDeploymentId: input.browserUseDeploymentId,
      requireExactDatasets: true,
    },
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
    piStateFiles: summary.piStateFiles,
  });
  return { skipped: false, summary };
}

async function collectDatasets(
  db: SqlExecutor,
  mode: "snapshot" | "verify",
  hasher: AuditHasher,
): Promise<UpgradeAuditManifest["datasets"]> {
  const result = {} as Omit<UpgradeAuditManifest["datasets"], "telegramFileRefs" | "postgresSequences">;
  for (const definition of DATASET_DEFINITIONS) {
    const table = dialectValue(definition.table, db.dialect);
    if (!(await tableExists(db, table))) {
      if (mode === "snapshot" && definition.snapshotOptional) {
        result[definition.name] = datasetFromRows(definition.name, [], definition.key, hasher);
        continue;
      }
      throw new Error(`Upgrade audit requires the ${table} table.`);
    }
    result[definition.name] = await collectDatasetInBatches(db, definition, hasher);
  }
  return {
    ...result,
    postgresSequences: await collectPostgresSequences(db, hasher),
    telegramFileRefs: await collectTelegramFileRefs(db, mode, hasher),
  };
}

async function collectDatasetInBatches(
  db: SqlExecutor,
  definition: DatasetDefinition,
  hasher: AuditHasher,
): Promise<UpgradeAuditManifest["datasets"][DatasetName]> {
  const entries: UpgradeAuditManifest["datasets"][DatasetName]["entries"] = [];
  const seenKeys = new Set<string>();
  for await (const row of queryDatasetRows(db, definition)) {
    const entry = datasetEntry(definition.name, row, definition.key, hasher);
    if (seenKeys.has(entry.keySha256)) {
      throw new Error(`Upgrade audit found duplicate ${definition.name} record keys.`);
    }
    seenKeys.add(entry.keySha256);
    entries.push(entry);
  }
  entries.sort((left, right) => left.keySha256.localeCompare(right.keySha256));
  return { count: entries.length, entries };
}

async function* queryDatasetRows(
  db: SqlExecutor,
  definition: DatasetDefinition,
): AsyncGenerator<Row> {
  const query = dialectValue(definition.query, db.dialect);
  let lastRow: Row | undefined;
  while (true) {
    const rows = await db.query<Row>(keysetPageQuery(query, definition.pageColumns, lastRow));
    for (const row of rows) yield row;
    if (rows.length < DATASET_BATCH_SIZE) break;
    lastRow = rows.at(-1);
  }
}

async function verifyDatasets(
  db: SqlExecutor,
  baseline: UpgradeAuditManifest["datasets"],
  requireExact: boolean,
  hasher: AuditHasher,
): Promise<void> {
  for (const definition of DATASET_DEFINITIONS) {
    const table = dialectValue(definition.table, db.dialect);
    if (!(await tableExists(db, table))) throw new Error(`Upgrade audit requires the ${table} table.`);
    await verifyDatasetFromDatabase(db, definition, baseline[definition.name], requireExact, hasher);
  }
  if (!(await tableExists(db, "telegram_file_refs"))) {
    throw new Error("Upgrade audit verification requires the migrated telegram_file_refs table.");
  }
  await verifyDatasetFromDatabase(
    db,
    TELEGRAM_FILE_REFS_DEFINITION,
    baseline.telegramFileRefs,
    requireExact,
    hasher,
  );
  verifyDataset(
    "postgresSequences",
    baseline.postgresSequences,
    await collectPostgresSequences(db, hasher),
    false,
  );
}

async function verifyDatasetFromDatabase(
  db: SqlExecutor,
  definition: DatasetDefinition,
  baseline: UpgradeAuditManifest["datasets"][DatasetName],
  requireExact: boolean,
  hasher: AuditHasher,
): Promise<void> {
  const remaining = new Map(baseline.entries.map((entry) => [entry.keySha256, entry.rowSha256]));
  let count = 0;
  let previousKey: string | undefined;
  for await (const row of queryDatasetRows(db, definition)) {
    const rawKey = stableJson(definition.key(row));
    if (rawKey === previousKey) {
      throw new Error(`Upgrade audit found duplicate ${definition.name} record keys.`);
    }
    previousKey = rawKey;
    count += 1;
    const actual = datasetEntry(definition.name, row, definition.key, hasher);
    const expected = remaining.get(actual.keySha256);
    if (expected === undefined) {
      if (requireExact) {
        throw new Error(`Upgrade audit failed: ${definition.name} membership differs from the baseline.`);
      }
      continue;
    }
    if (actual.rowSha256 !== expected) {
      throw new Error(`Upgrade audit failed: a baseline ${definition.name} record changed (${actual.keySha256}).`);
    }
    remaining.delete(actual.keySha256);
  }
  if (requireExact && count !== baseline.count) {
    throw new Error(`Upgrade audit failed: ${definition.name} membership differs from the baseline.`);
  }
  if (count < baseline.count) {
    throw new Error(`Upgrade audit failed: ${definition.name} count fell from ${baseline.count} to ${count}.`);
  }
  const missing = remaining.keys().next().value as string | undefined;
  if (missing) {
    throw new Error(`Upgrade audit failed: a baseline ${definition.name} record is missing (${missing}).`);
  }
}

function keysetPageQuery(
  query: string,
  columns: readonly string[],
  lastRow: Row | undefined,
) {
  const source = sql.raw(`select * from (${query}) audit_page`);
  const order = sql.raw(`order by ${columns.map(pgIdentifier).join(", ")}`);
  if (!lastRow) return sql`${source} ${order} limit ${DATASET_BATCH_SIZE}`;
  const terms = columns.map((column, index) => {
    const prefix = columns.slice(0, index).map((prefixColumn) =>
      sql`${sql.raw(pgIdentifier(prefixColumn))} = ${requiredPageValue(lastRow, prefixColumn)}`);
    const greater = sql`${sql.raw(pgIdentifier(column))} > ${requiredPageValue(lastRow, column)}`;
    return prefix.length ? sql`(${sql.join([...prefix, greater], sql` and `)})` : greater;
  });
  return sql`${source} where (${sql.join(terms, sql` or `)}) ${order} limit ${DATASET_BATCH_SIZE}`;
}

function requiredPageValue(row: Row, column: string): unknown {
  const value = row[column];
  if (value === null || value === undefined) {
    throw new Error(`Upgrade audit pagination column ${column} must not be null.`);
  }
  return value;
}

function dialectValue(value: DialectValue, dialect: "sqlite" | "postgres"): string {
  return typeof value === "string" ? value : value[dialect];
}

async function collectTelegramFileRefs(
  db: SqlExecutor,
  mode: "snapshot" | "verify",
  hasher: AuditHasher,
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
  if (mode === "verify" && !currentTableExists) {
    throw new Error("Upgrade audit verification requires the migrated telegram_file_refs table.");
  }
  if (mode === "snapshot") {
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
      const locator = parseTelegramLocator(row.id, row.locator_json, hasher);
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
  return datasetFromRows(
    "telegramFileRefs",
    rows,
    (row) => [row.fileId, row.telegramFileId],
    hasher,
  );
}

async function collectPostgresSequences(
  db: SqlExecutor,
  hasher: AuditHasher,
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
      incrementBy: sequence.increment_by,
    });
  }
  return datasetFromRows(
    "postgresSequences",
    rows,
    (row) => [row.sequenceSchemaName, row.tableSchemaName, row.tableName, row.columnName, row.sequenceName],
    hasher,
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
  hasher: AuditHasher,
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
      throw new Error(`Pi session for audited thread key ${opaqueKey(hasher, "thread", row.id)} is outside PI_CODING_AGENT_DIR.`);
    }
    const relativePath = path.relative(root, sessionPath);
    if (!relativePath) {
      throw new Error(`Pi session for audited thread key ${opaqueKey(hasher, "thread", row.id)} points at PI_CODING_AGENT_DIR itself.`);
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
      prefixSha256: await hasher.filePrefix(resolved.realPath, resolved.size),
    });
  }
  return { count: files.length, files };
}

async function verifyPiSessionPrefixes(
  piCodingAgentDir: string,
  files: UpgradeAuditManifest["piSessions"]["files"],
  hasher: AuditHasher,
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
    const currentPrefix = await hasher.filePrefix(resolved.realPath, baseline.size);
    if (currentPrefix !== baseline.prefixSha256) {
      throw new Error(`Preserved Pi session prefix changed: ${baseline.relativePath}`);
    }
  }
}

async function collectPiStateFiles(
  piCodingAgentDir: string,
  hasher: AuditHasher,
): Promise<UpgradeAuditManifest["piState"]> {
  const root = path.resolve(piCodingAgentDir);
  const realRoot = await fs.realpath(root);
  const files: UpgradeAuditManifest["piState"]["files"] = [];
  for (const relativePath of PI_STATE_FILES) {
    const statePath = path.join(root, relativePath);
    const exists = await fs.lstat(statePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) continue;
    const resolved = await resolveRegularFileWithin(realRoot, statePath);
    if (!resolved) throw new Error(`Pi state file is unsafe: ${relativePath}`);
    files.push({
      relativePath,
      size: resolved.size,
      sha256: await hasher.filePrefix(resolved.realPath, resolved.size),
    });
  }
  return { count: files.length, files };
}

async function verifyPiStateFiles(
  piCodingAgentDir: string,
  baselineFiles: UpgradeAuditManifest["piState"]["files"],
  hasher: AuditHasher,
): Promise<void> {
  const current = await collectPiStateFiles(piCodingAgentDir, hasher);
  if (current.count !== baselineFiles.length) {
    throw new Error("Upgrade audit failed: Pi state file membership differs from the baseline.");
  }
  const currentByPath = new Map(current.files.map((file) => [file.relativePath, file]));
  for (const baseline of baselineFiles) {
    const actual = currentByPath.get(baseline.relativePath);
    if (!actual) throw new Error(`Preserved Pi state file is missing: ${baseline.relativePath}`);
    if (actual.size !== baseline.size || actual.sha256 !== baseline.sha256) {
      throw new Error(`Preserved Pi state file changed: ${baseline.relativePath}`);
    }
  }
}

function datasetFromRows(
  name: DatasetName,
  rows: Row[],
  key: (row: Row) => unknown,
  hasher: AuditHasher,
): UpgradeAuditManifest["datasets"][DatasetName] {
  const entries = rows.map((row) => datasetEntry(name, row, key, hasher))
    .sort((left, right) => left.keySha256.localeCompare(right.keySha256));
  const keys = new Set(entries.map((entry) => entry.keySha256));
  if (keys.size !== entries.length) throw new Error(`Upgrade audit found duplicate ${name} record keys.`);
  return { count: entries.length, entries };
}

function datasetEntry(
  name: DatasetName,
  row: Row,
  key: (row: Row) => unknown,
  hasher: AuditHasher,
): UpgradeAuditManifest["datasets"][DatasetName]["entries"][number] {
  return {
    keySha256: opaqueKey(hasher, name, key(row)),
    rowSha256: hasher.digest(`${name}:row`, row),
  };
}

function verifyDataset(
  name: DatasetName,
  baseline: UpgradeAuditManifest["datasets"][DatasetName],
  current: UpgradeAuditManifest["datasets"][DatasetName],
  requireExact: boolean,
): void {
  if (requireExact && current.count !== baseline.count) {
    throw new Error(`Upgrade audit failed: ${name} membership differs from the baseline.`);
  }
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

function parseTelegramLocator(
  sourceId: number,
  locatorJson: string,
  hasher: AuditHasher,
): { fileId: string; uniqueId: string | null } {
  let locator: unknown;
  try {
    locator = JSON.parse(locatorJson);
  } catch (error) {
    throw new Error(`Telegram source ${opaqueKey(hasher, "file-source", sourceId)} has malformed locator JSON: ${formatError(error)}`);
  }
  if (!locator || typeof locator !== "object") {
    throw new Error(`Telegram source ${opaqueKey(hasher, "file-source", sourceId)} has a non-object locator.`);
  }
  const record = locator as Record<string, unknown>;
  const fileId = typeof record.file_id === "string" ? record.file_id.trim() : "";
  if (!fileId) throw new Error(`Telegram source ${opaqueKey(hasher, "file-source", sourceId)} has no file_id.`);
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

async function hmacSha256FilePrefix(filePath: string, size: number, key: Buffer): Promise<string> {
  const handle = await fs.open(filePath, "r");
  const hash = createHmac("sha256", key).update("upgrade-audit-file-prefix\0");
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
    piStateFiles: manifest.piState.count,
  };
}

function opaqueKey(hasher: AuditHasher, domain: string, key: unknown): string {
  return hasher.digest(`${domain}:key`, key);
}

function createAuditHasher(botToken: string): AuditHasher {
  const { token } = parseBotToken(botToken);
  const key = createHash("sha256").update("upgrade-audit-key\0").update(token).digest();
  return {
    digest: (domain, value) => createHmac("sha256", key)
      .update(`${domain}\0${stableJson(value)}`)
      .digest("hex"),
    filePrefix: (filePath, size) => hmacSha256FilePrefix(filePath, size, key),
  };
}

function parseBotToken(botToken: string): { token: string; botId: string } {
  const token = botToken.trim();
  const separator = token.indexOf(":");
  const botId = separator > 0 ? token.slice(0, separator) : "";
  if (!/^\d+$/.test(botId) || !token.slice(separator + 1)) {
    throw new Error("BOT_TOKEN must contain a valid Telegram bot identity prefix for upgrade auditing.");
  }
  return { token, botId };
}

function telegramBotIdentitySha256(botToken: string, hasher: AuditHasher): string {
  return hasher.digest("telegram-bot-identity", parseBotToken(botToken).botId);
}

function verifyTelegramBotIdentity(botToken: string, expectedSha256: string, hasher: AuditHasher): void {
  if (telegramBotIdentitySha256(botToken, hasher) !== expectedSha256) {
    throw new Error("Telegram bot identity does not match the upgrade baseline.");
  }
}

function e2bDeploymentIdentitySha256(deploymentId: string, hasher: AuditHasher): string {
  const normalized = deploymentId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(normalized)) {
    throw new Error("E2B_DEPLOYMENT_ID must be valid for upgrade auditing.");
  }
  return hasher.digest("e2b-deployment-identity", normalized);
}

function verifyE2bDeploymentIdentity(
  deploymentId: string,
  expectedSha256: string,
  hasher: AuditHasher,
): void {
  if (e2bDeploymentIdentitySha256(deploymentId, hasher) !== expectedSha256) {
    throw new Error("E2B deployment identity does not match the upgrade baseline.");
  }
}

function browserUseDeploymentIdentitySha256(deploymentId: string, hasher: AuditHasher): string {
  const normalized = deploymentId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(normalized)) {
    throw new Error("BROWSER_USE_DEPLOYMENT_ID must be valid for upgrade auditing.");
  }
  return hasher.digest("browser-use-deployment-identity", normalized);
}

function verifyBrowserUseDeploymentIdentity(
  deploymentId: string,
  expectedSha256: string,
  hasher: AuditHasher,
): void {
  if (browserUseDeploymentIdentitySha256(deploymentId, hasher) !== expectedSha256) {
    throw new Error("Browser Use deployment identity does not match the upgrade baseline.");
  }
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
