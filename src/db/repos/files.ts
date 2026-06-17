import { sql } from "drizzle-orm";
import { queryOne, valueList, type SqlExecutor } from "../sql.js";
import type { TextSearch } from "../search.js";
import type { FileChunkRow, FileRow, StoredFileType } from "../types.js";

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
    telegramFileId?: string | null;
    telegramFileUniqueId?: string | null;
    contentSha256?: string | null;
    name: string;
    path: string;
    size: number;
    contentMd?: string | null;
    summary?: string | null;
    outline?: unknown;
    isInline: boolean;
  }): Promise<FileRow> {
    return (await queryOne<FileRow>(
      this.db,
      sql`
        insert into files(user_id, thread_id, message_id, type, telegram_file_id, telegram_file_unique_id, content_sha256, name, path, size, content_md, summary, outline_json, is_inline, created_at)
        values (
          ${input.userId},
          ${input.threadId},
          ${input.messageId ?? null},
          ${input.type},
          ${input.telegramFileId ?? null},
          ${input.telegramFileUniqueId ?? null},
          ${input.contentSha256 ?? null},
          ${input.name},
          ${input.path},
          ${input.size},
          ${input.contentMd ?? null},
          ${input.summary ?? null},
          ${input.outline ? JSON.stringify(input.outline) : null},
          ${input.isInline ? 1 : 0},
          ${Date.now()}
        )
        returning *
      `,
    ))!;
  }

  async insertChunk(input: { fileId: number; idx: number; headingPath?: string | null; content: string }): Promise<FileChunkRow> {
    const inserted = (await queryOne<FileChunkRow>(
      this.db,
      sql`
        insert into file_chunks(file_id, idx, heading_path, content, created_at)
        values (${input.fileId}, ${input.idx}, ${input.headingPath ?? null}, ${input.content}, ${Date.now()})
        returning *
      `,
    ))!;
    await this.search.indexChunk(inserted.id, input.fileId, input.content);
    return inserted;
  }

  get(fileId: number): Promise<FileRow | undefined> {
    return queryOne<FileRow>(this.db, sql`select * from files where id = ${fileId}`);
  }

  findByTelegramFileUniqueId(uniqueId: string): Promise<FileRow | undefined> {
    return queryOne<FileRow>(
      this.db,
      sql`
        select distinct f.*
        from files f
        left join file_telegram_refs r on r.file_id = f.id
        where f.telegram_file_unique_id = ${uniqueId}
           or r.file_unique_id = ${uniqueId}
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
        order by id asc
        limit 1
      `,
    );
  }

  listForMessage(messageId: number): Promise<FileRow[]> {
    return this.db.query<FileRow>(sql`
      select distinct f.*
      from files f
      left join message_files mf on mf.file_id = f.id
      where mf.message_id = ${messageId}
         or f.message_id = ${messageId}
      order by f.id asc
    `);
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

  listByIds(fileIds: number[]): Promise<FileRow[]> {
    if (!fileIds.length) return Promise.resolve([]);
    return this.db.query<FileRow>(sql`select * from files where id in (${valueList(fileIds)}) order by id asc`);
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

  async updateTelegramFileId(fileId: number, telegramFileId: string): Promise<void> {
    await this.db.execute(sql`update files set telegram_file_id = ${telegramFileId} where id = ${fileId}`);
  }

  async updateContentHash(fileId: number, hash: string): Promise<void> {
    await this.db.execute(sql`update files set content_sha256 = ${hash} where id = ${fileId}`);
  }

  async updateSummary(fileId: number, summary: string | null): Promise<void> {
    await this.db.execute(sql`update files set summary = ${summary} where id = ${fileId}`);
  }

  async rememberTelegramFileRef(
    fileId: number,
    input: { fileUniqueId?: string | null; telegramFileId?: string | null },
  ): Promise<void> {
    await this.db.execute(sql`
      update files
      set telegram_file_id = coalesce(${input.telegramFileId ?? null}, telegram_file_id),
          telegram_file_unique_id = coalesce(telegram_file_unique_id, ${input.fileUniqueId ?? null})
      where id = ${fileId}
    `);
    if (!input.fileUniqueId) return;
    await this.db.execute(sql`
      insert into file_telegram_refs(file_unique_id, file_id, telegram_file_id, created_at)
      values (${input.fileUniqueId}, ${fileId}, ${input.telegramFileId ?? null}, ${Date.now()})
      on conflict(file_unique_id) do update set
        file_id = excluded.file_id,
        telegram_file_id = excluded.telegram_file_id
    `);
  }

  async setOutline(fileId: number, outline: unknown): Promise<void> {
    await this.db.execute(sql`update files set outline_json = ${JSON.stringify(outline)} where id = ${fileId}`);
  }

  chunks(fileId: number): Promise<FileChunkRow[]> {
    return this.db.query<FileChunkRow>(sql`select * from file_chunks where file_id = ${fileId} order by idx asc`);
  }

  async deleteFile(fileId: number): Promise<number[]> {
    const chunks = await this.chunks(fileId);
    const chunkIds = chunks.map((chunk) => chunk.id);
    await this.search.removeChunksForFile(fileId);
    await this.db.execute(sql`delete from file_telegram_refs where file_id = ${fileId}`);
    await this.db.execute(sql`delete from message_files where file_id = ${fileId}`);
    await this.db.execute(sql`delete from file_chunks where file_id = ${fileId}`);
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
