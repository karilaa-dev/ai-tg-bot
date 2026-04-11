import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

import type { ChatThreadRecord, CreateMessageInput, DatabaseRepository, MessageRecord } from '../domain.js';
import { groupMessages, mapThread, normalizeParts, nowIso } from './shared.js';

interface PoolClientLike {
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release?: () => void;
}

interface Queryable {
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  connect?: () => Promise<PoolClientLike>;
  end?: () => Promise<void>;
}

export class PostgresRepository implements DatabaseRepository {
  private readonly pool: Queryable;

  public constructor(input: { pool?: Queryable; connectionString?: string }) {
    if (input.pool) {
      this.pool = input.pool;
      return;
    }

    if (!input.connectionString) {
      throw new Error('A PostgreSQL connection string is required');
    }

    const poolConfig: PoolConfig = {
      connectionString: input.connectionString,
    };
    this.pool = new Pool(poolConfig);
  }

  public async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id BIGSERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        message_thread_id BIGINT NOT NULL DEFAULT 0,
        thinking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        compact_message TEXT,
        compacted_through_message_id BIGINT,
        is_generating BOOLEAN NOT NULL DEFAULT FALSE,
        active_draft_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(chat_id, message_thread_id)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        telegram_message_id BIGINT,
        responded_by_assistant_message_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS message_parts (
        id BIGSERIAL PRIMARY KEY,
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        part_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        telegram_file_id TEXT,
        media_type TEXT
      )
    `);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id, id)');
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS idx_messages_thread_pending ON messages(thread_id, role, responded_by_assistant_message_id, id)',
    );
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_message_parts_message_id ON message_parts(message_id, part_index)');
  }

  public async close(): Promise<void> {
    await this.pool.end?.();
  }

  public async getOrCreateThread(chatId: number, messageThreadId: number): Promise<ChatThreadRecord> {
    const now = nowIso();
    await this.pool.query(
      `
        INSERT INTO chat_threads (
          chat_id,
          message_thread_id,
          thinking_enabled,
          compact_message,
          compacted_through_message_id,
          is_generating,
          active_draft_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, FALSE, NULL, NULL, FALSE, NULL, $3, $4)
        ON CONFLICT (chat_id, message_thread_id) DO NOTHING
      `,
      [chatId, messageThreadId, now, now],
    );

    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      message_thread_id: string;
      thinking_enabled: boolean;
      compact_message: string | null;
      compacted_through_message_id: string | null;
      is_generating: boolean;
      active_draft_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>('SELECT * FROM chat_threads WHERE chat_id = $1 AND message_thread_id = $2', [chatId, messageThreadId]);

    const row = result.rows[0];
    if (!row) {
      throw new Error('Thread creation failed');
    }

    return mapThread(row);
  }

  public async getThreadByKey(chatId: number, messageThreadId: number): Promise<ChatThreadRecord | null> {
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      message_thread_id: string;
      thinking_enabled: boolean;
      compact_message: string | null;
      compacted_through_message_id: string | null;
      is_generating: boolean;
      active_draft_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>('SELECT * FROM chat_threads WHERE chat_id = $1 AND message_thread_id = $2', [chatId, messageThreadId]);

    return result.rows[0] ? mapThread(result.rows[0]) : null;
  }

  public async getThreadById(threadId: number): Promise<ChatThreadRecord | null> {
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      message_thread_id: string;
      thinking_enabled: boolean;
      compact_message: string | null;
      compacted_through_message_id: string | null;
      is_generating: boolean;
      active_draft_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>('SELECT * FROM chat_threads WHERE id = $1', [threadId]);

    return result.rows[0] ? mapThread(result.rows[0]) : null;
  }

  public async updateThinkingEnabled(threadId: number, enabled: boolean): Promise<ChatThreadRecord> {
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      message_thread_id: string;
      thinking_enabled: boolean;
      compact_message: string | null;
      compacted_through_message_id: string | null;
      is_generating: boolean;
      active_draft_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
        UPDATE chat_threads
        SET thinking_enabled = $1, updated_at = $2
        WHERE id = $3
        RETURNING *
      `,
      [enabled, nowIso(), threadId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Thread ${threadId} not found`);
    }

    return mapThread(row);
  }

  public async setGenerationState(threadId: number, isGenerating: boolean, activeDraftId: number | null): Promise<void> {
    await this.pool.query(
      'UPDATE chat_threads SET is_generating = $1, active_draft_id = $2, updated_at = $3 WHERE id = $4',
      [isGenerating, activeDraftId, nowIso(), threadId],
    );
  }

  public async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const parts = normalizeParts(input.parts);

    if (parts.length === 0) {
      throw new Error('Message must include at least one part');
    }

    return this.transaction(async (client) => {
      const timestamp = nowIso();
      const messageResult = await client.query<{
        id: string;
        thread_id: string;
        role: 'user' | 'assistant';
        telegram_message_id: string | null;
        responded_by_assistant_message_id: string | null;
        created_at: string | Date;
        updated_at: string | Date;
      }>(
        `
          INSERT INTO messages (
            thread_id,
            role,
            telegram_message_id,
            responded_by_assistant_message_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, NULL, $4, $5)
          RETURNING *
        `,
        [input.threadId, input.role, input.telegramMessageId ?? null, timestamp, timestamp],
      );

      const messageRow = messageResult.rows[0];
      if (!messageRow) {
        throw new Error('Message insert failed');
      }

      for (const [index, part] of parts.entries()) {
        await client.query(
          `
            INSERT INTO message_parts (
              message_id,
              part_index,
              type,
              text,
              telegram_file_id,
              media_type
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            Number(messageRow.id),
            index,
            part.type,
            part.type === 'text' ? part.text ?? null : null,
            part.type === 'image' ? part.telegramFileId ?? null : null,
            part.type === 'image' ? part.mediaType ?? null : null,
          ],
        );
      }

      const partRows = await client.query<{
        id: string;
        message_id: string;
        part_index: number;
        type: 'text' | 'image';
        text: string | null;
        telegram_file_id: string | null;
        media_type: string | null;
      }>('SELECT * FROM message_parts WHERE message_id = $1 ORDER BY part_index ASC', [Number(messageRow.id)]);

      return groupMessages([messageRow], partRows.rows)[0] as MessageRecord;
    });
  }

  public async listMessages(threadId: number): Promise<MessageRecord[]> {
    const messagesResult = await this.pool.query<{
      id: string;
      thread_id: string;
      role: 'user' | 'assistant';
      telegram_message_id: string | null;
      responded_by_assistant_message_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>('SELECT * FROM messages WHERE thread_id = $1 ORDER BY id ASC', [threadId]);

    if (messagesResult.rows.length === 0) {
      return [];
    }

    const ids = messagesResult.rows.map((row) => Number(row.id));
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
    const partRows = await this.pool.query<{
      id: string;
      message_id: string;
      part_index: number;
      type: 'text' | 'image';
      text: string | null;
      telegram_file_id: string | null;
      media_type: string | null;
    }>(`SELECT * FROM message_parts WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, part_index ASC`, ids);

    return groupMessages(messagesResult.rows, partRows.rows);
  }

  public async listPendingUserMessages(threadId: number): Promise<MessageRecord[]> {
    const messagesResult = await this.pool.query<{
      id: string;
      thread_id: string;
      role: 'user' | 'assistant';
      telegram_message_id: string | null;
      responded_by_assistant_message_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
        SELECT *
        FROM messages
        WHERE thread_id = $1 AND role = 'user' AND responded_by_assistant_message_id IS NULL
        ORDER BY id ASC
      `,
      [threadId],
    );

    if (messagesResult.rows.length === 0) {
      return [];
    }

    const ids = messagesResult.rows.map((row) => Number(row.id));
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
    const partRows = await this.pool.query<{
      id: string;
      message_id: string;
      part_index: number;
      type: 'text' | 'image';
      text: string | null;
      telegram_file_id: string | null;
      media_type: string | null;
    }>(`SELECT * FROM message_parts WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, part_index ASC`, ids);

    return groupMessages(messagesResult.rows, partRows.rows);
  }

  public async markUserMessagesResponded(userMessageIds: number[], assistantMessageId: number): Promise<void> {
    if (userMessageIds.length === 0) {
      return;
    }

    const placeholders = userMessageIds.map((_, index) => `$${index + 3}`).join(', ');
    await this.pool.query(
      `
        UPDATE messages
        SET responded_by_assistant_message_id = $1, updated_at = $2
        WHERE id IN (${placeholders})
      `,
      [assistantMessageId, nowIso(), ...userMessageIds],
    );
  }

  public async updateCompaction(
    threadId: number,
    compactMessage: string,
    throughMessageId: number,
  ): Promise<ChatThreadRecord> {
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      message_thread_id: string;
      thinking_enabled: boolean;
      compact_message: string | null;
      compacted_through_message_id: string | null;
      is_generating: boolean;
      active_draft_id: string | null;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `
        UPDATE chat_threads
        SET compact_message = $1, compacted_through_message_id = $2, updated_at = $3
        WHERE id = $4
        RETURNING *
      `,
      [compactMessage, throughMessageId, nowIso(), threadId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Thread ${threadId} not found`);
    }

    return mapThread(row);
  }

  private async transaction<T>(callback: (client: PoolClientLike) => Promise<T>): Promise<T> {
    if (!(this.pool instanceof Pool)) {
      const clientLike = this.pool as unknown as PoolClientLike;
      return callback(clientLike);
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
