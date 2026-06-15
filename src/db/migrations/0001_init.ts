import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../sql.js";
import type { DialectName } from "../types.js";

export async function up(db: SqlExecutor, dialect: DialectName): Promise<void> {
  if (dialect === "sqlite") await sqlite(db);
  else await postgres(db);
}

export async function down(db: SqlExecutor, dialect: DialectName): Promise<void> {
  const tables = [
    "embeddings",
    "summaries",
    "file_telegram_refs",
    "message_files",
    "file_chunks",
    "files",
    "messages",
    "threads",
    "invites",
    "users",
  ];
  if (dialect === "sqlite") {
    await db.execute(sql`drop table if exists messages_fts`);
    await db.execute(sql`drop table if exists chunks_fts`);
    await db.execute(sql`drop table if exists summaries_fts`);
  } else {
    await db.execute(sql`drop table if exists message_search`);
    await db.execute(sql`drop table if exists chunk_search`);
    await db.execute(sql`drop table if exists summary_search`);
  }
  for (const table of tables) {
    await db.execute(sql.raw(`drop table if exists ${table}`));
  }
}

async function sqlite(db: SqlExecutor): Promise<void> {
  await db.execute(sql`pragma journal_mode = wal`);
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
  await commonTables(db, "integer primary key autoincrement", "integer", "blob");
  await db.execute(sql`create virtual table if not exists messages_fts using fts5(text, message_id unindexed, thread_id unindexed)`);
  await db.execute(sql`create virtual table if not exists chunks_fts using fts5(text, chunk_id unindexed, file_id unindexed)`);
  await db.execute(sql`create virtual table if not exists summaries_fts using fts5(text, summary_id unindexed, thread_id unindexed)`);
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
  await commonTables(db, "bigserial primary key", "bigint", "bytea");
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
  await db.execute(sql`
    create table if not exists summary_search (
      summary_id bigint primary key references summaries(id) on delete cascade,
      thread_id bigint not null,
      text text not null,
      ts tsvector not null
    )
  `);
  await db.execute(sql`create index if not exists summary_search_ts_idx on summary_search using gin(ts)`);
  await db.execute(sql`create index if not exists summary_search_thread_idx on summary_search(thread_id)`);
}

async function commonTables(
  db: SqlExecutor,
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
      meta_summary text,
      compacted_upto_message_id ${intType},
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
      tokens_est integer,
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
      telegram_file_id text,
      telegram_file_unique_id text,
      content_sha256 text,
      name text not null,
      path text not null,
      size integer not null,
      content_md text,
      summary text,
      outline_json text,
      is_inline integer not null,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists file_telegram_refs (
      file_unique_id text primary key,
      file_id ${intType} not null references files(id) on delete cascade,
      telegram_file_id text,
      created_at ${intType} not null
    )
  `));
  await db.execute(sql.raw(`create index if not exists file_telegram_refs_file_id_idx on file_telegram_refs(file_id)`));
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
    create table if not exists summaries (
      id ${idType},
      thread_id ${intType} not null references threads(id),
      level integer not null,
      from_message_id ${intType} not null,
      to_message_id ${intType} not null,
      content text not null,
      created_at ${intType} not null
    )
  `));
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
  await addColumnIfMissing(db, "files", "telegram_file_id", "text");
  await addColumnIfMissing(db, "files", "telegram_file_unique_id", "text");
  await addColumnIfMissing(db, "files", "content_sha256", "text");
  await db.execute(sql.raw(`create unique index if not exists files_telegram_file_unique_id_idx on files(telegram_file_unique_id)`));
  await db.execute(sql.raw(`create index if not exists files_content_sha256_idx on files(content_sha256, type, size)`));
  await db.execute(sql`
    insert into file_telegram_refs(file_unique_id, file_id, telegram_file_id, created_at)
    select f.telegram_file_unique_id, f.id, f.telegram_file_id, f.created_at
    from files f
    where f.telegram_file_unique_id is not null
      and not exists (
        select 1 from file_telegram_refs r
        where r.file_unique_id = f.telegram_file_unique_id
      )
  `);
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
  await addColumnIfMissing(db, "embeddings", "model", "text");
}

async function addColumnIfMissing(db: SqlExecutor, table: string, column: string, definition: string): Promise<void> {
  try {
    await db.execute(sql.raw(`alter table ${table} add column ${column} ${definition}`));
  } catch (err) {
    if (!/duplicate column|already exists/i.test(errorText(err))) throw err;
  }
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return `${err.name}: ${err.message}${cause ? `\n${errorText(cause)}` : ""}`;
}
