import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./sql.js";
import type { DialectName } from "./types.js";

export async function initializeSchema(db: SqlExecutor, dialect: DialectName): Promise<void> {
  if (dialect === "sqlite") {
    await db.execute(sql`pragma foreign_keys = on`);
    await db.execute(sql`pragma journal_mode = wal`);
  }
  await db.transaction(async (tx) => {
    if (dialect === "postgres") await tx.execute(sql`select pg_advisory_xact_lock(938472615)`);
    if (dialect === "sqlite") await initializeSqlite(tx);
    else await initializePostgres(tx);
  });
}

async function initializeSqlite(db: SqlExecutor): Promise<void> {
  await db.execute(sql`
    create table if not exists users (
      tg_id integer primary key,
      first_name text,
      username text,
      lang text not null default 'en',
      tz_offset_min integer,
      stream_mode integer not null default 1,
      created_at integer not null
    )
  `);
  await initializeCommonTables(db, "integer primary key autoincrement", "integer", "blob");
  await db.execute(sql`create virtual table if not exists messages_fts using fts5(text, message_id unindexed, thread_id unindexed)`);
  await db.execute(sql`create virtual table if not exists chunks_fts using fts5(text, chunk_id unindexed, file_id unindexed)`);
}

async function initializePostgres(db: SqlExecutor): Promise<void> {
  await db.execute(sql`
    create table if not exists users (
      tg_id bigint primary key,
      first_name text,
      username text,
      lang text not null default 'en',
      tz_offset_min integer,
      stream_mode integer not null default 1,
      created_at bigint not null
    )
  `);
  await initializeCommonTables(db, "bigserial primary key", "bigint", "bytea");
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

async function initializeCommonTables(
  db: SqlExecutor,
  idType: string,
  intType: string,
  blobType: string,
): Promise<void> {
  await db.execute(sql.raw(`
    create table if not exists threads (
      id ${idType},
      user_id ${intType} not null references users(tg_id),
      topic_id integer,
      parent_thread_id ${intType},
      fork_point_message_id ${intType},
      title text not null,
      title_source text not null default 'explicit',
      title_attempts integer not null default 0,
      topic_title_synced integer not null default 1,
      pi_session_file text,
      pi_session_id text,
      archived integer not null default 0,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists thread_sandboxes (
      deployment_id text not null,
      user_id ${intType} not null references users(tg_id),
      thread_id ${intType} not null references threads(id) on delete cascade,
      sandbox_id text not null unique,
      created_at ${intType} not null,
      updated_at ${intType} not null,
      primary key(deployment_id, thread_id)
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists browser_use_profiles (
      deployment_id text not null,
      user_id ${intType} not null references users(tg_id) on delete cascade,
      provider_user_key text not null unique,
      profile_id text,
      created_at ${intType} not null,
      updated_at ${intType} not null,
      primary key(deployment_id, user_id)
    )
  `));
  await db.execute(sql.raw(`create unique index if not exists browser_use_profiles_profile_idx on browser_use_profiles(profile_id) where profile_id is not null`));
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
      size integer not null,
      content_md text,
      summary text,
      outline_json text,
      is_inline integer not null,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create index if not exists files_content_sha256_idx on files(content_sha256, type, size)`));
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
    create table if not exists telegram_file_refs (
      id ${idType},
      file_id ${intType} not null references files(id) on delete cascade,
      telegram_file_id text not null,
      telegram_file_unique_id text,
      direction text not null,
      media_kind text not null,
      telegram_message_id ${intType},
      width integer,
      height integer,
      telegram_size ${intType},
      is_primary integer not null,
      first_seen_at ${intType} not null,
      last_seen_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create unique index if not exists telegram_file_refs_file_tg_idx on telegram_file_refs(file_id, telegram_file_id)`));
  await db.execute(sql.raw(`create index if not exists telegram_file_refs_unique_idx on telegram_file_refs(telegram_file_unique_id)`));
  await db.execute(sql.raw(`create index if not exists telegram_file_refs_restore_idx on telegram_file_refs(file_id, is_primary, last_seen_at)`));
  await db.execute(sql.raw(`
    create table if not exists sandbox_file_restore_status (
      deployment_id text not null,
      thread_id ${intType} not null references threads(id) on delete cascade,
      sandbox_id text not null,
      file_id ${intType} not null references files(id) on delete cascade,
      telegram_file_ref_id ${intType} references telegram_file_refs(id) on delete set null,
      sandbox_name text not null,
      status text not null,
      restored_size ${intType},
      restored_sha256 text,
      error_code text,
      error_detail text,
      attempted_at ${intType} not null,
      completed_at ${intType},
      primary key(deployment_id, sandbox_id, file_id)
    )
  `));
  await db.execute(sql.raw(`create index if not exists sandbox_file_restore_thread_idx on sandbox_file_restore_status(deployment_id, thread_id, attempted_at)`));
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
}
