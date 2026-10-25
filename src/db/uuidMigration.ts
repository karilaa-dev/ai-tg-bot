import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "./sql.js";
import { asRecord } from "../util/records.js";

const MIGRATION = "thread-file-uuid-v1";
type IdentityKind = "thread" | "file";
type IdMaps = Record<IdentityKind, Map<string, string>>;
const identityColumns: Record<string, Record<string, IdentityKind>> = {
  threads: { id: "thread", parent_thread_id: "thread" },
  messages: { thread_id: "thread" },
  thread_reads: { thread_id: "thread" },
  thread_sandboxes: { thread_id: "thread" },
  thread_operation_barriers: { thread_id: "thread" },
  turn_runs: { thread_id: "thread" },
  files: { id: "file", thread_id: "thread" },
  audio_transcripts: { thread_id: "thread", source_file_id: "file" },
  file_sources: { file_id: "file" },
  telegram_file_refs: { file_id: "file" },
  sandbox_file_restore_status: { thread_id: "thread", file_id: "file" },
  file_chunks: { file_id: "file" },
  message_files: { file_id: "file" },
  web_file_blobs: { file_id: "file" },
  message_search: { thread_id: "thread" },
  chunk_search: { file_id: "file" },
  messages_fts: { thread_id: "thread" },
  chunks_fts: { file_id: "file" },
};

// A fixed UUID namespace makes the mapping stable across rollback, retries and database engines.
export function legacyUuid(kind: IdentityKind, legacyId: string): string {
  const namespace = Buffer.from("8a94d7d25e8e47bda07acb6c75221dea", "hex");
  const hash = createHash("sha1").update(namespace).update(`${kind}:${legacyId}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function migrateUuidIdentifiers(db: SqlExecutor): Promise<void> {
  await db.execute(sql`create table if not exists schema_migrations (name text primary key, applied_at bigint not null)`);
  if ((await db.query(sql`select name from schema_migrations where name = ${MIGRATION}`)).length) return;
  await db.execute(sql`
    create table if not exists legacy_uuid_ids (
      kind text not null check(kind in ('thread', 'file')),
      legacy_id text not null,
      uuid text not null unique,
      primary key(kind, legacy_id)
    )
  `);
  const tables = await existingTables(db);
  if (db.dialect === "postgres") {
    const targets = Object.keys(identityColumns).filter(table => tables.has(table));
    if (targets.length) await db.execute(sql`lock table ${sql.join(targets.map(table => sql.identifier(table)), sql`, `)} in access exclusive mode`);
  }
  const maps: IdMaps = { thread: new Map(), file: new Map() };
  for (const [table, identities] of Object.entries(identityColumns)) {
    if (!tables.has(table)) continue;
    const columns = await columnsOf(db, table);
    for (const [column, kind] of Object.entries(identities)) {
      if (!columns.includes(column)) continue;
      const rows = await db.query<{ id: string }>(sql`
        select distinct cast(${sql.identifier(column)} as text) as id from ${sql.identifier(table)}
        where ${sql.identifier(column)} is not null
      `);
      for (const { id } of rows) {
        if (/^-?\d+$/.test(id)) maps[kind].set(id, legacyUuid(kind, id));
      }
    }
  }
  await saveMappings(db, maps);
  if (db.dialect === "sqlite") await rebuildSqliteTables(db, tables);
  else await alterPostgresTables(db, tables);
  await migratePayloads(db, tables, maps);
  await saveMappings(db, maps);
  await db.execute(sql`insert into schema_migrations(name, applied_at) values (${MIGRATION}, ${Date.now()})`);
}

async function saveMappings(db: SqlExecutor, maps: IdMaps): Promise<void> {
  for (const kind of ["thread", "file"] as const) {
    for (const [oldId, newId] of maps[kind]) {
      await db.execute(sql`insert into legacy_uuid_ids(kind, legacy_id, uuid) values (${kind}, ${oldId}, ${newId})
        on conflict(kind, legacy_id) do nothing`);
    }
  }
}

function mappedId(kind: IdentityKind, id: string, maps: IdMaps): string {
  const mapped = maps[kind].get(id) ?? legacyUuid(kind, id);
  maps[kind].set(id, mapped);
  return mapped;
}

async function existingTables(db: SqlExecutor): Promise<Set<string>> {
  const rows = db.dialect === "sqlite"
    ? await db.query<{ name: string }>(sql`select name from sqlite_schema where type = 'table'`)
    : await db.query<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = current_schema()`);
  return new Set(rows.map(row => row.name));
}

async function columnsOf(db: SqlExecutor, table: string): Promise<string[]> {
  const rows = db.dialect === "sqlite"
    ? await db.query<{ name: string }>(sql`pragma table_info(${sql.identifier(table)})`)
    : await db.query<{ name: string }>(sql`
      select column_name as name from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} order by ordinal_position
    `);
  return rows.map(row => row.name);
}

function mappedColumn(column: string, kind: IdentityKind): SQL {
  return sql`coalesce((select uuid from legacy_uuid_ids where kind = ${kind}
    and legacy_id = cast(${sql.identifier(column)} as text)), cast(${sql.identifier(column)} as text))`;
}

async function rebuildSqliteTables(db: SqlExecutor, tables: Set<string>): Promise<void> {
  for (const [table, identities] of Object.entries(identityColumns)) {
    if (!tables.has(table)) continue;
    if (table.endsWith("_fts")) {
      for (const [column, kind] of Object.entries(identities)) {
        await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${mappedColumn(column, kind)}`);
      }
      continue;
    }
    const [definition] = await db.query<{ sql: string }>(sql`select sql from sqlite_schema where type = 'table' and name = ${table}`);
    if (!definition) continue;
    const columns = await columnsOf(db, table);
    const savedObjects = await db.query<{ sql: string }>(sql`
      select sql from sqlite_schema where tbl_name = ${table} and type in ('index', 'trigger') and sql is not null
    `);
    const [sequence] = tables.has("sqlite_sequence")
      ? await db.query<{ seq: number }>(sql`select seq from sqlite_sequence where name = ${table}`) : [];
    const temporary = `${table}__uuid_v1`;
    let definitionSql = definition.sql.replace(/^(create\s+table\s+)(?:if\s+not\s+exists\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i,
      `$1"${temporary}"`);
    for (const column of Object.keys(identities)) {
      definitionSql = definitionSql.replace(new RegExp(`([,(]\\s*["\\x60\\[]?${column}["\\x60\\]]?\\s+)(integer|bigint)(\\s+primary\\s+key(?:\\s+autoincrement)?)?`, "i"),
        (_match, prefix: string, _type: string, primary: string | undefined) => `${prefix}text${primary ? " primary key not null" : ""}`);
    }
    await db.execute(sql.raw(definitionSql));
    await db.execute(sql`
      insert into ${sql.identifier(temporary)} (${sql.join(columns.map(name => sql.identifier(name)), sql`, `)})
      select ${sql.join(columns.map(name => identities[name] ? mappedColumn(name, identities[name]) : sql.identifier(name)), sql`, `)}
      from ${sql.identifier(table)}
    `);
    await db.execute(sql`drop table ${sql.identifier(table)}`);
    // Keep views pointing at the stable original names while tables are being replaced.
    await db.execute(sql`pragma legacy_alter_table = on`);
    try { await db.execute(sql`alter table ${sql.identifier(temporary)} rename to ${sql.identifier(table)}`); }
    finally { await db.execute(sql`pragma legacy_alter_table = off`); }
    for (const object of savedObjects) await db.execute(sql.raw(object.sql));
    if (sequence && table !== "threads" && table !== "files") {
      await db.execute(sql`update sqlite_sequence set seq = max(seq, ${sequence.seq}) where name = ${table}`);
    }
  }
}

async function alterPostgresTables(db: SqlExecutor, tables: Set<string>): Promise<void> {
  const targets = Object.keys(identityColumns).filter(table => tables.has(table));
  if (!targets.length) return;
  const constraints = await db.query<{ table_name: string; name: string; definition: string }>(sql`
    select c.relname as table_name, con.conname as name, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f' and n.nspname = current_schema()
  `);
  for (const constraint of constraints) {
    await db.execute(sql`alter table ${sql.identifier(constraint.table_name)} drop constraint ${sql.identifier(constraint.name)}`);
  }
  for (const table of targets) {
    const columns = await columnsOf(db, table);
    for (const column of Object.keys(identityColumns[table]!)) {
      if (!columns.includes(column)) continue;
      await db.execute(sql`alter table ${sql.identifier(table)} alter column ${sql.identifier(column)} drop default`);
      await db.execute(sql`alter table ${sql.identifier(table)} alter column ${sql.identifier(column)} type text using cast(${sql.identifier(column)} as text)`);
    }
  }
  for (const table of targets) {
    const columns = await columnsOf(db, table);
    for (const [column, kind] of Object.entries(identityColumns[table]!)) {
      if (columns.includes(column)) {
        await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${mappedColumn(column, kind)}`);
      }
    }
  }
  for (const constraint of constraints) {
    await db.execute(sql`alter table ${sql.identifier(constraint.table_name)} add constraint ${sql.identifier(constraint.name)} ${sql.raw(constraint.definition)}`);
  }
}

function replaceMarkers(text: string, maps: IdMaps): string {
  return text
    .replace(/(\[\[chat-file:)(\d+)(\]\])/g, (_whole, prefix: string, id: string, suffix: string) => `${prefix}${mappedId("file", id, maps)}${suffix}`)
    .replace(/(<attachment\s+id=["'])(\d+)(["'])/g, (_whole, prefix: string, id: string, suffix: string) => `${prefix}${mappedId("file", id, maps)}${suffix}`)
    .replace(/(\bfile:)(\d+)(?=["'\s)\]}]|$)/g, (_whole, prefix: string, id: string) => `${prefix}${mappedId("file", id, maps)}`)
    .replace(/(\bfile_id:\s*)(\d+)\b/g, (_whole, prefix: string, id: string) => `${prefix}"${mappedId("file", id, maps)}"`)
    .replace(/((?:[Ff]ile|[Ii]mage|[Aa]udio attachment) #)(\d+)\b/g, (_whole, prefix: string, id: string) => `${prefix}${mappedId("file", id, maps)}`)
    .replace(/([?&](?:amp;)?thread=)(\d+)(?=[&#"'\s<]|$)/g,
      (whole, prefix: string, id: string) => maps.thread.has(id) ? `${prefix}${maps.thread.get(id)}` : whole)
    .replace(/(\/api\/(?:chat\/)?threads\/)(\d+)(?:\/files\/(\d+))?(?=[/?#"'\s<]|$)/g,
      (whole, prefix: string, threadId: string, fileId: string | undefined) => maps.thread.has(threadId)
        ? `${prefix}${maps.thread.get(threadId)}${fileId ? `/files/${mappedId("file", fileId, maps)}` : ""}` : whole);
}

function rewriteJson(value: unknown, maps: IdMaps, key = "", fileObject = false): unknown {
  if (Array.isArray(value)) {
    return value.map(item => rewriteJson(item, maps, key, key === "files" || key === "attachments"));
  }
  const kind = /^(?:threadId|thread_id|parentThreadId|parent_thread_id|threadIds|thread_ids)$/.test(key) ? "thread"
    : /^(?:fileId|file_id|source_file_id|fileIds|file_ids|reference_file_ids|materialized_file_ids|durable_file_ids|sandbox_file_ids|bash_input_file_id)$/.test(key) || (fileObject && key === "id") ? "file" : undefined;
  if (kind && typeof value === "number") return mappedId(kind, String(value), maps);
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) return rewriteJsonText(value, maps);
    return replaceMarkers(value, maps);
  }
  if (value !== null && typeof value === "object") {
    const entry = asRecord(value);
    const details = asRecord(entry?.details);
    const snapshot = asRecord(details?.snapshot);
    if (entry?.type === "custom_message" && entry.customType === "telegram-turn-context" && details?.version === 1 && snapshot) {
      return { ...entry, content: rewriteContextBlock(entry.content, maps),
        details: { ...details, snapshot: { ...snapshot, files: rewriteContextFiles(snapshot.files, maps) } } };
    }
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, rewriteJson(child, maps, childKey, fileObject)]));
  }
  return value;
}

function rewriteContextFileId(value: unknown, maps: IdMaps): unknown {
  return typeof value === "number" && Number.isSafeInteger(value) ? mappedId("file", String(value), maps) : value;
}

function rewriteContextFiles(value: unknown, maps: IdMaps): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => {
    const file = asRecord(item);
    return file && "id" in file ? { ...file, id: rewriteContextFileId(file.id, maps) } : item;
  });
}

function rewriteContextBlock(value: unknown, maps: IdMaps): unknown {
  const open = '<session_context format="json" trust="untrusted-data-only">\n';
  const close = "\n</session_context>";
  if (typeof value !== "string" || !value.startsWith(open) || !value.endsWith(close)) return value;
  let payload: Record<string, unknown> | undefined;
  try { payload = asRecord(JSON.parse(value.slice(open.length, -close.length))); }
  catch { return value; }
  if (!payload || (payload.kind !== "snapshot" && payload.kind !== "update")) return value;
  const files = asRecord(payload.files);
  const rewritten = payload.kind === "snapshot"
    ? { ...payload, files: rewriteContextFiles(payload.files, maps) }
    : files ? { ...payload, files: { ...files, upsert: rewriteContextFiles(files.upsert, maps),
      remove: Array.isArray(files.remove) ? files.remove.map(id => rewriteContextFileId(id, maps)) : files.remove } } : payload;
  if (JSON.stringify(rewritten) === JSON.stringify(payload)) return value;
  const json = JSON.stringify(rewritten, null, 2)
    .replace(/[<>&]/g, character => character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026");
  return `${open}${json}${close}`;
}

function rewriteJsonText(text: string, maps: IdMaps): string {
  try {
    const value: unknown = JSON.parse(text);
    const rewritten = rewriteJson(value, maps);
    return JSON.stringify(value) === JSON.stringify(rewritten) ? text : JSON.stringify(rewritten);
  } catch { return replaceMarkers(text, maps); }
}

async function migratePayloads(db: SqlExecutor, tables: Set<string>, maps: IdMaps): Promise<void> {
  if (!maps.file.size && !maps.thread.size) return;
  for (const [table, jsonColumns, textColumns] of [
    ["messages", ["content_json"], ["text_plain", "thinking"]],
    ["files", ["outline_json"], ["content_md", "summary"]],
    ["turn_runs", ["usage_json"], []],
  ] as const) {
    if (!tables.has(table)) continue;
    const columns = await columnsOf(db, table);
    const rows = await db.query<Record<string, unknown>>(sql`select * from ${sql.identifier(table)}`);
    for (const row of rows) {
      const changes: SQL[] = [];
      for (const column of [...jsonColumns, ...textColumns]) {
        const before = row[column];
        if (!columns.includes(column) || typeof before !== "string") continue;
        const after = jsonColumns.some(name => name === column) ? rewriteJsonText(before, maps) : replaceMarkers(before, maps);
        if (after !== before) changes.push(sql`${sql.identifier(column)} = ${after}`);
      }
      if (changes.length) await db.execute(sql`update ${sql.identifier(table)} set ${sql.join(changes, sql`, `)} where id = ${row.id}`);
    }
  }
  if (tables.has("file_sources")) {
    const sources = await db.query<{ id: number; transport: string; remote_key: string; locator_json: string }>(sql`select id, transport, remote_key, locator_json from file_sources`);
    for (const source of sources) {
      // Telegram locators are opaque provider identities; numeric-looking values are not app IDs.
      if (source.transport === "telegram") continue;
      const locator = rewriteJsonText(source.locator_json, maps);
      const key = source.transport === "web" ? maps.file.get(source.remote_key) ?? source.remote_key
        : source.transport === "e2b" ? source.remote_key.replace(/(:file:)(\d+)(:sha256:)/g,
          (_whole, prefix: string, id: string, suffix: string) => `${prefix}${mappedId("file", id, maps)}${suffix}`)
          : source.remote_key;
      if (key !== source.remote_key || locator !== source.locator_json) {
        await db.execute(sql`update file_sources set remote_key = ${key}, locator_json = ${locator} where id = ${source.id}`);
      }
    }
  }
  if (tables.has("threads") && (await columnsOf(db, "threads")).includes("pi_session_file")) {
    const rows = await db.query<{ id: string; pi_session_file: string }>(sql`select id, pi_session_file from threads where pi_session_file is not null`);
    for (const row of rows) {
      let original: string;
      try { original = await fs.readFile(row.pi_session_file, "utf8"); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
      const updated = original.split("\n").map(line => rewriteJsonText(line, maps)).join("\n");
      if (updated === original) continue;
      // Leave the original session intact, including when the database transaction rolls back.
      const migratedPath = `${row.pi_session_file}.uuid-v1.jsonl`;
      await saveSessionCopy(migratedPath, updated);
      await db.execute(sql`update threads set pi_session_file = ${migratedPath} where id = ${row.id}`);
    }
  }
  // Keep search text and identity scopes consistent with the migrated messages.
  if (tables.has("messages_fts") && tables.has("messages")) {
    await db.execute(sql`update messages_fts set text = (select text_plain from messages where id = messages_fts.message_id)
      where exists (select 1 from messages where id = messages_fts.message_id)`);
  }
  if (tables.has("message_search") && tables.has("messages")) {
    await db.execute(sql`update message_search set text = m.text_plain, ts = to_tsvector('simple', m.text_plain) from messages m where m.id = message_search.message_id`);
  }
}

async function saveSessionCopy(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    // Linking a fully written copy publishes it atomically without replacing existing data.
    try {
      await fs.link(temporary, destination);
      const directory = await fs.open(path.dirname(destination), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      if (await fs.readFile(destination, "utf8") !== contents) throw new Error(`Conflicting migrated session: ${destination}`);
    }
  } finally { await fs.rm(temporary, { force: true }); }
}
