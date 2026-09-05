import { sql } from "drizzle-orm";
import { insertReturning, queryOne, valueList, type SqlExecutor } from "../sql.js";
import { createTextSearch, messageScopePredicate, type MessageSearchScope, type TextSearch } from "../search.js";
import type {
  FileChunkRow,
  FileRow,
  FileSourceRow,
  StoredFileType,
  TelegramFileRefRow,
} from "../types.js";
import type { ChatFileSource } from "../../files/source.js";

export class FilesRepo {
  constructor(
    private readonly db: SqlExecutor,
    private readonly search: TextSearch,
  ) {}

  async insertFile(input: {
    userId: number;
    threadId: number;
    messageId?: number | null;
    type: StoredFileType;
    contentSha256?: string | null;
    mimeType?: string | null;
    extractionStatus?: FileRow["extraction_status"];
    name: string;
    size: number;
    contentMd?: string | null;
    summary?: string | null;
    outline?: unknown;
    isInline: boolean;
  }): Promise<FileRow> {
    return insertReturning<FileRow>(
      this.db,
      sql`
        insert into files(user_id, thread_id, message_id, type, content_sha256, mime_type, extraction_status, name, size, content_md, summary, outline_json, is_inline, created_at)
        values (
          ${input.userId},
          ${input.threadId},
          ${input.messageId ?? null},
          ${input.type},
          ${input.contentSha256 ?? null},
          ${input.mimeType ?? null},
          ${input.extractionStatus ?? "ready"},
          ${input.name},
          ${input.size},
          ${input.contentMd ?? null},
          ${input.summary ?? null},
          ${input.outline ? JSON.stringify(input.outline) : null},
          ${input.isInline ? 1 : 0},
          ${Date.now()}
        )
        returning *
      `,
    );
  }

  async insertChunk(input: { fileId: number; idx: number; headingPath?: string | null; content: string }): Promise<FileChunkRow> {
    const inserted = await insertReturning<FileChunkRow>(
      this.db,
      sql`
        insert into file_chunks(file_id, idx, heading_path, content, created_at)
        values (${input.fileId}, ${input.idx}, ${input.headingPath ?? null}, ${input.content}, ${Date.now()})
        returning *
      `,
    );
    await this.search.indexChunk(inserted.id, input.fileId, input.content);
    return inserted;
  }

  get(fileId: number): Promise<FileRow | undefined> {
    return queryOne<FileRow>(this.db, sql`select * from files where id = ${fileId}`);
  }

  findBySource(source: Pick<ChatFileSource, "transport" | "connectionKey" | "remoteKey">): Promise<FileRow | undefined> {
    return queryOne<FileRow>(
      this.db,
      sql`
        select distinct f.*
        from files f
        join file_sources s on s.file_id = f.id
        where s.transport = ${source.transport}
          and s.connection_key = ${source.connectionKey}
          and s.remote_key = ${source.remoteKey}
        order by f.id asc
        limit 1
      `,
    );
  }

  findByContentHash(
    hash: string,
    input: { type: StoredFileType; size: number },
  ): Promise<FileRow | undefined> {
    return queryOne<FileRow>(
      this.db,
      sql`
        select *
        from files
        where content_sha256 = ${hash}
          and type = ${input.type}
          and size = ${input.size}
          and extraction_status = 'ready'
        order by id asc
        limit 1
      `,
    );
  }

  listForMessage(messageId: number): Promise<FileRow[]> {
    return this.listForMessages([messageId]);
  }

  listForMessages(messageIds: number[]): Promise<FileRow[]> {
    if (!messageIds.length) return Promise.resolve([]);
    return this.db.query<FileRow>(sql`
      select distinct f.*
      from files f
      left join message_files mf on mf.file_id = f.id
      where mf.message_id in (${valueList(messageIds)})
         or f.message_id in (${valueList(messageIds)})
      order by f.id asc
    `);
  }

  async listVisibleIds(scopes: MessageSearchScope[], includeUnattachedInbound: boolean): Promise<number[]> {
    if (!scopes.length) return [];
    const threadIds = scopes.map((scope) => scope.threadId);
    const visibleMessage = messageScopePredicate(sql`m.thread_id`, sql`m.id`, threadIds, scopes);
    const rows = await this.db.query<{ id: number }>(sql`
      select id from (
        select f.id, 1 as attached
        from files f join messages m on m.id = f.message_id
        where ${visibleMessage}
        union
        select mf.file_id as id, 1 as attached
        from message_files mf join messages m on m.id = mf.message_id
        where ${visibleMessage}
        union all
        select f.id, 0 as attached
        from files f
        where f.message_id is null and f.thread_id in (${valueList(threadIds)})
          and not exists (select 1 from message_files mf where mf.file_id = f.id)
          and (${includeUnattachedInbound ? 1 : 0} = 1 or not (
            exists (select 1 from telegram_file_refs r where r.file_id = f.id and r.direction = 'inbound')
            or exists (select 1 from file_sources s where s.file_id = f.id and s.transport = 'telegram')
          ))
      ) candidates
      order by attached desc, id asc
    `);
    return rows.map((row) => row.id);
  }

  listByIds(fileIds: number[]): Promise<FileRow[]> {
    if (!fileIds.length) return Promise.resolve([]);
    return this.db.query<FileRow>(sql`select * from files where id in (${valueList(fileIds)}) order by id asc`);
  }

  async listRecoverableIds(fileIds: number[]): Promise<number[]> {
    if (!fileIds.length) return [];
    const rows = await this.db.query<{ id: number }>(sql`
      select f.id
      from files f
      where f.id in (${valueList(fileIds)})
        and (
          f.content_md is not null
          or exists (select 1 from file_chunks fc where fc.file_id = f.id)
          or exists (select 1 from file_sources fs where fs.file_id = f.id)
        )
      order by f.id asc
    `);
    return rows.map((row) => row.id);
  }

  listByIdsWithSource(fileIds: number[], transport: string, connectionKey: string): Promise<FileRow[]> {
    if (!fileIds.length) return Promise.resolve([]);
    return this.db.query<FileRow>(sql`
      select distinct f.*
      from files f
      join file_sources s on s.file_id = f.id
      where f.id in (${valueList(fileIds)})
        and s.transport = ${transport}
        and s.connection_key = ${connectionKey}
      order by f.id asc
    `);
  }

  async setMessageId(
    fileId: number,
    messageId: number,
    attachment: { displayName?: string | null; caption?: string | null } = {},
  ): Promise<void> {
    await this.db.execute(sql`update files set message_id = coalesce(message_id, ${messageId}) where id = ${fileId}`);
    const file = await this.get(fileId);
    await this.attachToMessage(messageId, fileId, {
      displayName: attachment.displayName ?? file?.name ?? null,
      caption: attachment.caption ?? null,
    });
  }

  async attachToMessage(
    messageId: number,
    fileId: number,
    input: { displayName?: string | null; caption?: string | null } = {},
  ): Promise<void> {
    await this.db.execute(sql`
      insert into message_files(message_id, file_id, display_name, caption, created_at)
      values (${messageId}, ${fileId}, ${input.displayName ?? null}, ${input.caption ?? null}, ${Date.now()})
      on conflict(message_id, file_id) do update set
        display_name = excluded.display_name,
        caption = excluded.caption
    `);
  }

  async updateContentHash(fileId: number, hash: string): Promise<void> {
    await this.db.execute(sql`update files set content_sha256 = ${hash} where id = ${fileId}`);
  }

  async updateExtractionStatus(fileId: number, status: FileRow["extraction_status"]): Promise<void> {
    await this.db.execute(sql`update files set extraction_status = ${status} where id = ${fileId}`);
  }

  async updateExtraction(fileId: number, input: {
    contentSha256: string;
    mimeType: string | null;
    size: number;
    contentMd: string | null;
    summary: string | null;
    outline: unknown;
    isInline: boolean;
    status: FileRow["extraction_status"];
  }): Promise<FileRow> {
    await this.db.execute(sql`
      update files set
        content_sha256 = ${input.contentSha256},
        mime_type = ${input.mimeType},
        size = ${input.size},
        content_md = ${input.contentMd},
        summary = ${input.summary},
        outline_json = ${input.outline === null ? null : JSON.stringify(input.outline)},
        is_inline = ${input.isInline ? 1 : 0},
        extraction_status = ${input.status}
      where id = ${fileId}
    `);
    const updated = await this.get(fileId);
    if (!updated) throw new Error(`File #${fileId} disappeared while updating its extracted content.`);
    return updated;
  }

  async replaceDocumentExtraction(fileId: number, input: {
    contentSha256: string;
    mimeType: string | null;
    size: number;
    contentMd: string | null;
    summary: string | null;
    isInline: boolean;
    chunks: Array<{
      idx: number;
      headingPath: string | null;
      content: string;
    }>;
  }): Promise<FileRow> {
    return this.db.transaction(async (tx) => {
      const transactionalSearch = createTextSearch(tx, tx.dialect);
      await transactionalSearch.removeChunksForFile(fileId);
      await tx.execute(sql`delete from file_chunks where file_id = ${fileId}`);
      const outline = input.chunks.map((chunk) => ({
        chunk_index: chunk.idx,
        heading_path: chunk.headingPath,
      }));
      await tx.execute(sql`
        update files set
          content_sha256 = ${input.contentSha256},
          mime_type = ${input.mimeType},
          size = ${input.size},
          content_md = ${input.contentMd},
          summary = ${input.summary},
          outline_json = ${outline.length ? JSON.stringify(outline) : null},
          is_inline = ${input.isInline ? 1 : 0},
          extraction_status = 'ready'
        where id = ${fileId}
      `);
      for (const chunk of input.chunks) {
        const inserted = await insertReturning<FileChunkRow>(tx, sql`
          insert into file_chunks(file_id, idx, heading_path, content, created_at)
          values (${fileId}, ${chunk.idx}, ${chunk.headingPath}, ${chunk.content}, ${Date.now()})
          returning *
        `);
        await transactionalSearch.indexChunk(inserted.id, fileId, inserted.content);
      }
      const updated = await queryOne<FileRow>(tx, sql`select * from files where id = ${fileId}`);
      if (!updated) throw new Error(`File #${fileId} disappeared while replacing its extracted content.`);
      return updated;
    });
  }

  async updateSummary(fileId: number, summary: string | null): Promise<void> {
    await this.db.execute(sql`update files set summary = ${summary} where id = ${fileId}`);
  }

  async rememberSource(fileId: number, source: ChatFileSource): Promise<FileSourceRow> {
    return insertReturning<FileSourceRow>(this.db, sql`
      insert into file_sources(
        file_id, transport, connection_key, remote_key, locator_json, mime_type, last_verified_at, created_at
      ) values (
        ${fileId},
        ${source.transport},
        ${source.connectionKey},
        ${source.remoteKey},
        ${JSON.stringify(source.locator)},
        ${source.mimeType ?? null},
        ${Date.now()},
        ${Date.now()}
      )
      on conflict(transport, connection_key, remote_key) do update set
        locator_json = excluded.locator_json,
        mime_type = coalesce(excluded.mime_type, file_sources.mime_type),
        last_verified_at = excluded.last_verified_at
      returning *
    `);
  }

  async rememberTelegramFileRefs(
    fileId: number,
    input: TelegramFileObservation,
  ): Promise<TelegramFileRefRow[]> {
    return this.db.transaction(async (tx) => {
      return rememberTelegramRefs(tx, fileId, input, Date.now());
    });
  }

  async rememberTelegramObservation(
    fileId: number,
    source: ChatFileSource,
    input: TelegramFileObservation,
  ): Promise<{ source: FileSourceRow; refs: TelegramFileRefRow[] }> {
    return this.db.transaction(async (tx) => {
      const now = Date.now();
      const storedSource = await insertReturning<FileSourceRow>(tx, sql`
        insert into file_sources(
          file_id, transport, connection_key, remote_key, locator_json, mime_type, last_verified_at, created_at
        ) values (
          ${fileId},
          ${source.transport},
          ${source.connectionKey},
          ${source.remoteKey},
          ${JSON.stringify(source.locator)},
          ${source.mimeType ?? null},
          ${now},
          ${now}
        )
        on conflict(transport, connection_key, remote_key) do update set
          locator_json = excluded.locator_json,
          mime_type = coalesce(excluded.mime_type, file_sources.mime_type),
          last_verified_at = excluded.last_verified_at
        returning *
      `);
      const refs = await rememberTelegramRefs(tx, storedSource.file_id, input, now);
      return { source: storedSource, refs };
    });
  }

  listTelegramFileRefs(fileIds: number[]): Promise<TelegramFileRefRow[]> {
    if (!fileIds.length) return Promise.resolve([]);
    return this.db.query<TelegramFileRefRow>(sql`
      select * from telegram_file_refs
      where file_id in (${valueList(fileIds)})
      order by file_id asc, is_primary desc, last_seen_at desc, id desc
    `);
  }

  listSources(fileId: number): Promise<FileSourceRow[]> {
    return this.db.query<FileSourceRow>(sql`
      select * from file_sources
      where file_id = ${fileId}
      order by
        case transport when 'e2b' then 0 when 'telegram' then 1 else 2 end,
        case when last_verified_at is null then 1 else 0 end,
        last_verified_at desc,
        id desc
    `);
  }

  async deleteE2BSourcesForSandbox(connectionKey: string, sandboxId: string): Promise<number> {
    const prefix = `${sandboxId}:`;
    const deleted = await this.db.query<{ id: number }>(sql`
      delete from file_sources
      where transport = 'e2b'
        and connection_key = ${connectionKey}
        and substr(remote_key, 1, ${prefix.length}) = ${prefix}
      returning id
    `);
    return deleted.length;
  }

  listE2BSourcesForSandbox(connectionKey: string, sandboxId: string): Promise<FileSourceRow[]> {
    const prefix = `${sandboxId}:`;
    return this.db.query<FileSourceRow>(sql`
      select * from file_sources
      where transport = 'e2b'
        and connection_key = ${connectionKey}
        and substr(remote_key, 1, ${prefix.length}) = ${prefix}
      order by id asc
    `);
  }

  async deleteSourcesByIds(sourceIds: number[]): Promise<number> {
    if (!sourceIds.length) return 0;
    const deleted = await this.db.query<{ id: number }>(sql`
      delete from file_sources
      where id in (${valueList(sourceIds)})
      returning id
    `);
    return deleted.length;
  }

  async markSourceVerified(sourceId: number): Promise<void> {
    await this.db.execute(sql`update file_sources set last_verified_at = ${Date.now()} where id = ${sourceId}`);
  }

  async setOutline(fileId: number, outline: unknown): Promise<void> {
    await this.db.execute(sql`update files set outline_json = ${JSON.stringify(outline)} where id = ${fileId}`);
  }

  chunks(fileId: number): Promise<FileChunkRow[]> {
    return this.db.query<FileChunkRow>(sql`select * from file_chunks where file_id = ${fileId} order by idx asc`);
  }

  async clearChunks(fileId: number): Promise<number[]> {
    const chunks = await this.chunks(fileId);
    await this.search.removeChunksForFile(fileId);
    await this.db.execute(sql`delete from file_chunks where file_id = ${fileId}`);
    return chunks.map((chunk) => chunk.id);
  }

  async deleteFile(fileId: number): Promise<number[]> {
    const chunkIds = await this.clearChunks(fileId);
    await this.db.execute(sql`delete from file_sources where file_id = ${fileId}`);
    await this.db.execute(sql`delete from message_files where file_id = ${fileId}`);
    await this.db.execute(sql`delete from files where id = ${fileId}`);
    return chunkIds;
  }

  listForThreads(threadIds: number[]): Promise<FileRow[]> {
    if (!threadIds.length) return Promise.resolve([]);
    return this.db.query<FileRow>(sql`
      select distinct f.*
      from files f
      left join message_files mf on mf.file_id = f.id
      left join messages m on m.id = mf.message_id
      where f.thread_id in (${valueList(threadIds)})
         or m.thread_id in (${valueList(threadIds)})
      order by f.id asc
    `);
  }


  chunksForFiles(fileIds: number[]): Promise<FileChunkRow[]> {
    if (!fileIds.length) return Promise.resolve([]);
    return this.db.query<FileChunkRow>(sql`select * from file_chunks where file_id in (${valueList(fileIds)}) order by file_id asc, idx asc`);
  }
}

type TelegramFileObservation = {
  direction: TelegramFileRefRow["direction"];
  mediaKind: TelegramFileRefRow["media_kind"];
  telegramMessageId?: number | null;
  refs: Array<{
    fileId: string;
    fileUniqueId?: string | null;
    width?: number | null;
    height?: number | null;
    size?: number | null;
    primary: boolean;
  }>;
};

async function rememberTelegramRefs(
  db: SqlExecutor,
  fileId: number,
  input: TelegramFileObservation,
  now: number,
): Promise<TelegramFileRefRow[]> {
  for (const ref of input.refs) {
    const telegramFileId = ref.fileId.trim();
    if (!telegramFileId) continue;
    const uniqueId = ref.fileUniqueId?.trim() || null;
    await db.execute(sql`
      insert into telegram_file_refs(
        file_id, telegram_file_id, telegram_file_unique_id, direction, media_kind,
        telegram_message_id, width, height, telegram_size, is_primary, first_seen_at, last_seen_at
      ) values (
        ${fileId}, ${telegramFileId}, ${uniqueId}, ${input.direction}, ${input.mediaKind},
        ${input.telegramMessageId ?? null}, ${ref.width ?? null}, ${ref.height ?? null},
        ${ref.size ?? null}, ${ref.primary ? 1 : 0}, ${now}, ${now}
      )
      on conflict(file_id, telegram_file_id) do update set
        telegram_file_unique_id = coalesce(excluded.telegram_file_unique_id, telegram_file_refs.telegram_file_unique_id),
        telegram_message_id = coalesce(excluded.telegram_message_id, telegram_file_refs.telegram_message_id),
        width = coalesce(excluded.width, telegram_file_refs.width),
        height = coalesce(excluded.height, telegram_file_refs.height),
        telegram_size = coalesce(excluded.telegram_size, telegram_file_refs.telegram_size),
        is_primary = case when excluded.is_primary = 1 then 1 else telegram_file_refs.is_primary end,
        last_seen_at = excluded.last_seen_at
    `);
  }
  return db.query<TelegramFileRefRow>(sql`
    select * from telegram_file_refs
    where file_id = ${fileId}
    order by is_primary desc, last_seen_at desc, id desc
  `);
}
