import { sql } from "drizzle-orm";
import { insertReturning, queryOne, valueList, type SqlExecutor } from "../sql.js";
import { createTextSearch, type TextSearch } from "../search.js";
import type { FileChunkRow, FileRow, FileSourceRow, StoredFileType } from "../types.js";
import type { ChatFileSource } from "../../files/source.js";
import { vectorToBuffer } from "./embeddings.js";

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
    path?: string | null;
    size: number;
    contentMd?: string | null;
    summary?: string | null;
    outline?: unknown;
    isInline: boolean;
  }): Promise<FileRow> {
    return insertReturning<FileRow>(
      this.db,
      sql`
        insert into files(user_id, thread_id, message_id, type, content_sha256, mime_type, extraction_status, name, path, size, content_md, summary, outline_json, is_inline, created_at)
        values (
          ${input.userId},
          ${input.threadId},
          ${input.messageId ?? null},
          ${input.type},
          ${input.contentSha256 ?? null},
          ${input.mimeType ?? null},
          ${input.extractionStatus ?? "ready"},
          ${input.name},
          ${input.path ?? null},
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
      vector?: Float32Array;
    }>;
    embeddingModel: string | null;
  }): Promise<FileRow> {
    return this.db.transaction(async (tx) => {
      const transactionalSearch = createTextSearch(tx, tx.dialect);
      const oldChunks = await tx.query<FileChunkRow>(sql`
        select * from file_chunks where file_id = ${fileId} order by idx asc
      `);
      await transactionalSearch.removeChunksForFile(fileId);
      if (oldChunks.length) {
        await tx.execute(sql`delete from embeddings where kind = 'chunk' and ref_id in (${valueList(oldChunks.map((chunk) => chunk.id))})`);
      }
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
        if (chunk.vector) {
          await tx.execute(sql`
            insert into embeddings(kind, ref_id, model, dim, vector, created_at)
            values ('chunk', ${inserted.id}, ${input.embeddingModel}, ${chunk.vector.length}, ${vectorToBuffer(chunk.vector)}, ${Date.now()})
          `);
        }
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

  listSources(fileId: number): Promise<FileSourceRow[]> {
    return this.db.query<FileSourceRow>(sql`
      select * from file_sources
      where file_id = ${fileId}
      order by case when last_verified_at is null then 1 else 0 end, last_verified_at desc, id desc
    `);
  }

  async markSourceVerified(sourceId: number): Promise<void> {
    await this.db.execute(sql`update file_sources set last_verified_at = ${Date.now()} where id = ${sourceId}`);
  }

  async clearPath(fileId: number): Promise<void> {
    await this.db.execute(sql`update files set path = null where id = ${fileId}`);
  }

  async setPath(fileId: number, filePath: string): Promise<void> {
    await this.db.execute(sql`update files set path = ${filePath} where id = ${fileId}`);
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
