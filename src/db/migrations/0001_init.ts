import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../sql.js";
import type { DialectName } from "../types.js";

export interface MigrationResult {
  piCutoverApplied: boolean;
  deletedRows: Record<string, number>;
  fileSourcesApplied: boolean;
  migratedFileSources: number;
}

export async function up(db: SqlExecutor, dialect: DialectName): Promise<MigrationResult> {
  if (dialect === "sqlite") await db.execute(sql`pragma journal_mode = wal`);
  return db.transaction(async (tx) => {
    if (dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472615)`);
    if (dialect === "sqlite") await sqlite(tx);
    else await postgres(tx);
    const cutover = await piCutover(tx, dialect);
    const fileSources = await migrateFileSourcesLocked(tx, dialect);
    return { ...cutover, ...fileSources };
  });
}

async function sqlite(db: SqlExecutor): Promise<void> {
  await db.execute(sql`
    create table if not exists users (
      tg_id integer primary key,
      first_name text,
      username text,
      lang text not null default 'en',
      tz_offset_min integer,
      stream_mode integer not null default 1,
      invited_with text,
      created_at integer not null
    )
  `);
  await commonTables(db, "sqlite", "integer primary key autoincrement", "integer", "blob");
  await db.execute(sql`create virtual table if not exists messages_fts using fts5(text, message_id unindexed, thread_id unindexed)`);
  await db.execute(sql`create virtual table if not exists chunks_fts using fts5(text, chunk_id unindexed, file_id unindexed)`);
}

async function postgres(db: SqlExecutor): Promise<void> {
  await db.execute(sql`
    create table if not exists users (
      tg_id bigint primary key,
      first_name text,
      username text,
      lang text not null default 'en',
      tz_offset_min integer,
      stream_mode integer not null default 1,
      invited_with text,
      created_at bigint not null
    )
  `);
  await commonTables(db, "postgres", "bigserial primary key", "bigint", "bytea");
  await db.execute(sql`
    create table if not exists message_search (
      message_id bigint primary key references messages(id) on delete cascade,
      thread_id bigint not null,
      text text not null,
      ts tsvector not null
    )
  `);
  await db.execute(sql`create index if not exists message_search_ts_idx on message_search using gin(ts)`);
  await db.execute(sql`create index if not exists message_search_thread_idx on message_search(thread_id)`);
  await db.execute(sql`
    create table if not exists chunk_search (
      chunk_id bigint primary key references file_chunks(id) on delete cascade,
      file_id bigint not null,
      text text not null,
      ts tsvector not null
    )
  `);
  await db.execute(sql`create index if not exists chunk_search_ts_idx on chunk_search using gin(ts)`);
  await db.execute(sql`create index if not exists chunk_search_file_idx on chunk_search(file_id)`);
}

async function commonTables(
  db: SqlExecutor,
  dialect: DialectName,
  idType: string,
  intType: string,
  blobType: string,
): Promise<void> {
  await db.execute(sql.raw(`
    create table if not exists invites (
      code text primary key,
      max_uses integer not null,
      used_count integer not null default 0,
      expires_at ${intType},
      revoked integer not null default 0,
      created_by ${intType} not null,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists threads (
      id ${idType},
      user_id ${intType} not null references users(tg_id),
      topic_id integer,
      parent_thread_id ${intType},
      fork_point_message_id ${intType},
      title text not null,
      pi_session_file text,
      pi_session_id text,
      archived integer not null default 0,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists messages (
      id ${idType},
      thread_id ${intType} not null references threads(id),
      role text not null,
      kind text not null,
      content_json text not null,
      text_plain text not null,
      thinking text,
      tg_message_id ${intType},
      pi_entry_id text,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create index if not exists messages_thread_id_idx on messages(thread_id, id)`));
  await db.execute(sql.raw(`
    create table if not exists files (
      id ${idType},
      user_id ${intType} not null references users(tg_id),
      thread_id ${intType} not null references threads(id),
      message_id ${intType},
      type text not null,
      content_sha256 text,
      mime_type text,
      extraction_status text not null default 'ready',
      name text not null,
      path text,
      size integer not null,
      content_md text,
      summary text,
      outline_json text,
      is_inline integer not null,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists file_sources (
      id ${idType},
      file_id ${intType} not null references files(id) on delete cascade,
      transport text not null,
      connection_key text not null,
      remote_key text not null,
      locator_json text not null,
      mime_type text,
      last_verified_at ${intType},
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create index if not exists file_sources_file_id_idx on file_sources(file_id)`));
  await db.execute(sql.raw(`create unique index if not exists file_sources_remote_idx on file_sources(transport, connection_key, remote_key)`));
  await db.execute(sql.raw(`
    create table if not exists file_chunks (
      id ${idType},
      file_id ${intType} not null references files(id),
      idx integer not null,
      heading_path text,
      content text not null,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create unique index if not exists file_chunks_file_idx_idx on file_chunks(file_id, idx)`));
  await db.execute(sql.raw(`
    create table if not exists message_files (
      message_id ${intType} not null references messages(id) on delete cascade,
      file_id ${intType} not null references files(id) on delete cascade,
      display_name text,
      caption text,
      created_at ${intType} not null,
      primary key(message_id, file_id)
    )
  `));
  await db.execute(sql.raw(`create index if not exists message_files_file_id_idx on message_files(file_id)`));
  await db.execute(sql.raw(`
    create table if not exists embeddings (
      id ${idType},
      kind text not null,
      ref_id ${intType} not null,
      model text,
      dim integer not null,
      vector ${blobType} not null,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create unique index if not exists embeddings_kind_ref_idx on embeddings(kind, ref_id)`));
  await addColumnIfMissing(db, dialect, "files", "content_sha256", "text");
  await addColumnIfMissing(db, dialect, "files", "mime_type", "text");
  await addColumnIfMissing(db, dialect, "files", "extraction_status", "text not null default 'ready'");
  await db.execute(sql.raw(`create index if not exists files_content_sha256_idx on files(content_sha256, type, size)`));
  await db.execute(sql`
    insert into message_files(message_id, file_id, display_name, caption, created_at)
    select f.message_id, f.id, f.name, null, f.created_at
    from files f
    where f.message_id is not null
      and not exists (
        select 1 from message_files mf
        where mf.message_id = f.message_id and mf.file_id = f.id
      )
  `);
  await addColumnIfMissing(db, dialect, "embeddings", "model", "text");
  await addColumnIfMissing(db, dialect, "threads", "pi_session_file", "text");
  await addColumnIfMissing(db, dialect, "threads", "pi_session_id", "text");
  await addColumnIfMissing(db, dialect, "messages", "pi_entry_id", "text");
}

async function piCutover(
  db: SqlExecutor,
  dialect: DialectName,
): Promise<Pick<MigrationResult, "piCutoverApplied" | "deletedRows">> {
  await db.execute(sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at bigint not null
    )
  `);
  return piCutoverLocked(db, dialect);
}

async function piCutoverLocked(
  tx: SqlExecutor,
  dialect: DialectName,
): Promise<Pick<MigrationResult, "piCutoverApplied" | "deletedRows">> {
    const applied = await tx.query<{ name: string }>(sql`
      select name from schema_migrations where name = 'pi_cutover_v2' limit 1
    `);
    if (applied.length) return { piCutoverApplied: false, deletedRows: {} };

    const deletedRows: Record<string, number> = {};
    for (const table of ["threads", "messages", "files", "file_chunks", "embeddings", "summaries"]) {
      deletedRows[table] = await safeCount(tx, dialect, table);
    }

    if (dialect === "sqlite") {
      await tx.execute(sql`delete from messages_fts`);
      await tx.execute(sql`delete from chunks_fts`);
      await tx.execute(sql.raw("drop table if exists summaries_fts"));
    } else {
      await tx.execute(sql`delete from message_search`);
      await tx.execute(sql`delete from chunk_search`);
      await tx.execute(sql.raw("drop table if exists summary_search"));
    }
    await tx.execute(sql`delete from message_files`);
    if (await tableExists(tx, dialect, "file_telegram_refs")) await tx.execute(sql`delete from file_telegram_refs`);
    await tx.execute(sql`delete from file_sources`);
    await tx.execute(sql`delete from embeddings`);
    await tx.execute(sql.raw("drop table if exists summaries"));
    await tx.execute(sql`delete from file_chunks`);
    await tx.execute(sql`delete from files`);
    await tx.execute(sql`delete from messages`);
    await tx.execute(sql`delete from threads`);
    if (dialect === "sqlite") {
      const columns = await tx.query<{ name: string; notnull: number }>(sql.raw("pragma table_info(files)"));
      if (columns.find((column) => column.name === "path")?.notnull) {
        await tx.execute(sql.raw("alter table files drop column path"));
        await tx.execute(sql.raw("alter table files add column path text"));
      }
    } else {
      await tx.execute(sql.raw("alter table files alter column path drop not null"));
    }
    await dropColumnIfExists(tx, dialect, "threads", "meta_summary");
    await dropColumnIfExists(tx, dialect, "threads", "compacted_upto_message_id");
    await dropColumnIfExists(tx, dialect, "messages", "tokens_est");
    await tx.execute(sql`insert into schema_migrations(name, applied_at) values ('pi_cutover_v2', ${Date.now()})`);
    return { piCutoverApplied: true, deletedRows };
}

async function migrateFileSourcesLocked(
  tx: SqlExecutor,
  dialect: DialectName,
): Promise<{ fileSourcesApplied: boolean; migratedFileSources: number }> {
  const applied = await tx.query<{ name: string }>(sql`
    select name from schema_migrations where name = 'chat_file_sources_v1' limit 1
  `);
  if (applied.length) return { fileSourcesApplied: false, migratedFileSources: 0 };

  const before = await safeCount(tx, dialect, "file_sources");
  if (await columnExists(tx, dialect, "files", "telegram_file_id")) {
    const rows = await tx.query<{
      id: number;
      telegram_file_id: string | null;
      telegram_file_unique_id: string | null;
      mime_type: string | null;
      created_at: number;
    }>(sql.raw(`
      select id, telegram_file_id, telegram_file_unique_id, mime_type, created_at
      from files
      where telegram_file_id is not null or telegram_file_unique_id is not null
    `));
    for (const row of rows) {
      const telegramFileId = row.telegram_file_id?.trim() || null;
      const uniqueId = row.telegram_file_unique_id?.trim() || null;
      const remoteKey = uniqueId ?? telegramFileId;
      if (!remoteKey) continue;
      await insertMigratedTelegramSource(tx, {
        fileId: row.id,
        remoteKey,
        telegramFileId,
        uniqueId,
        mimeType: row.mime_type,
        createdAt: row.created_at,
      });
    }
  }
  if (await tableExists(tx, dialect, "file_telegram_refs")) {
    const refs = await tx.query<{
      file_id: number;
      file_unique_id: string;
      telegram_file_id: string | null;
      created_at: number;
    }>(sql.raw(`select file_id, file_unique_id, telegram_file_id, created_at from file_telegram_refs`));
    for (const ref of refs) {
      await insertMigratedTelegramSource(tx, {
        fileId: ref.file_id,
        remoteKey: ref.file_unique_id,
        telegramFileId: ref.telegram_file_id?.trim() || null,
        uniqueId: ref.file_unique_id,
        mimeType: null,
        createdAt: ref.created_at,
      });
    }
    await tx.execute(sql.raw("drop table file_telegram_refs"));
  }

  await tx.execute(sql.raw("drop index if exists files_telegram_file_unique_id_idx"));
  await dropColumnIfExists(tx, dialect, "files", "telegram_file_id");
  await dropColumnIfExists(tx, dialect, "files", "telegram_file_unique_id");
  const after = await safeCount(tx, dialect, "file_sources");
  await tx.execute(sql`insert into schema_migrations(name, applied_at) values ('chat_file_sources_v1', ${Date.now()})`);
  return { fileSourcesApplied: true, migratedFileSources: Math.max(0, after - before) };
}

async function insertMigratedTelegramSource(
  tx: SqlExecutor,
  input: {
    fileId: number;
    remoteKey: string;
    telegramFileId: string | null;
    uniqueId: string | null;
    mimeType: string | null;
    createdAt: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into file_sources(
      file_id, transport, connection_key, remote_key, locator_json, mime_type, last_verified_at, created_at
    ) values (
      ${input.fileId},
      'telegram',
      'default',
      ${input.remoteKey},
      ${JSON.stringify({ file_id: input.telegramFileId, file_unique_id: input.uniqueId })},
      ${input.mimeType},
      null,
      ${input.createdAt}
    )
    on conflict(transport, connection_key, remote_key) do update set
      locator_json = excluded.locator_json,
      mime_type = coalesce(excluded.mime_type, file_sources.mime_type)
  `);
}

async function safeCount(db: SqlExecutor, dialect: DialectName, table: string): Promise<number> {
  if (!(await tableExists(db, dialect, table))) return 0;
  const rows = await db.query<{ count: number }>(sql.raw(`select count(*) as count from ${table}`));
  return Number(rows[0]?.count ?? 0);
}

async function dropColumnIfExists(
  db: SqlExecutor,
  dialect: DialectName,
  table: string,
  column: string,
): Promise<void> {
  if (!(await columnExists(db, dialect, table, column))) return;
  await db.execute(sql.raw(`alter table ${table} drop column ${column}`));
}

async function addColumnIfMissing(
  db: SqlExecutor,
  dialect: DialectName,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (await columnExists(db, dialect, table, column)) return;
  await db.execute(sql.raw(`alter table ${table} add column ${column} ${definition}`));
}

async function tableExists(db: SqlExecutor, dialect: DialectName, table: string): Promise<boolean> {
  if (dialect === "sqlite") {
    const rows = await db.query<{ name: string }>(sql`
      select name from sqlite_master where type = 'table' and name = ${table} limit 1
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

async function columnExists(db: SqlExecutor, dialect: DialectName, table: string, column: string): Promise<boolean> {
  if (dialect === "sqlite") {
    const rows = await db.query<{ name: string }>(sql.raw(`pragma table_info(${table})`));
    return rows.some((row) => row.name === column);
  }
  const rows = await db.query<{ exists: boolean }>(sql`
    select exists(
      select 1 from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} and column_name = ${column}
    ) as exists
  `);
  return Boolean(rows[0]?.exists);
}
