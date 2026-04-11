import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import sqlite3 from 'sqlite3';

import type { ChatThreadRecord, CreateMessageInput, DatabaseRepository, MessageRecord } from '../domain.js';
import { groupMessages, mapThread, normalizeParts, nowIso } from './shared.js';

type SqliteRunResult = {
  lastID: number;
  changes: number;
};

type SqliteDatabase = sqlite3.Database;

export class SQLiteRepository implements DatabaseRepository {
  private db: SqliteDatabase | null = null;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly filename: string) {}

  public async initialize(): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true });
    const sqlite = sqlite3.verbose();

    this.db = await new Promise<SqliteDatabase>((resolve, reject) => {
      const database = new sqlite.Database(this.filename, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(database);
      });
    });

    await this.exec('PRAGMA foreign_keys = ON');
    await this.exec(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        thinking_enabled INTEGER NOT NULL DEFAULT 0,
        compact_message TEXT,
        compacted_through_message_id INTEGER,
        is_generating INTEGER NOT NULL DEFAULT 0,
        active_draft_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, message_thread_id)
      )
    `);
    await this.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        telegram_message_id INTEGER,
        responded_by_assistant_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
      )
    `);
    await this.exec(`
      CREATE TABLE IF NOT EXISTS message_parts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        telegram_file_id TEXT,
        media_type TEXT,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      )
    `);
    await this.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id, id)');
    await this.exec(
      'CREATE INDEX IF NOT EXISTS idx_messages_thread_pending ON messages(thread_id, role, responded_by_assistant_message_id, id)',
    );
    await this.exec('CREATE INDEX IF NOT EXISTS idx_message_parts_message_id ON message_parts(message_id, part_index)');
  }

  public async close(): Promise<void> {
    if (!this.db) {
      return;
    }

    const db = this.db;
    this.db = null;
    await new Promise<void>((resolve, reject) => {
      db.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  public async getOrCreateThread(chatId: number, messageThreadId: number): Promise<ChatThreadRecord> {
    const now = nowIso();
    await this.run(
      `
        INSERT OR IGNORE INTO chat_threads (
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
        VALUES (?, ?, 0, NULL, NULL, 0, NULL, ?, ?)
      `,
      [chatId, messageThreadId, now, now],
    );

    const row = await this.get<{
      id: number;
      chat_id: number;
      message_thread_id: number;
      thinking_enabled: number;
      compact_message: string | null;
      compacted_through_message_id: number | null;
      is_generating: number;
      active_draft_id: number | null;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM chat_threads WHERE chat_id = ? AND message_thread_id = ?', [chatId, messageThreadId]);

    if (!row) {
      throw new Error('Thread creation failed');
    }

    return mapThread(row);
  }

  public async getThreadByKey(chatId: number, messageThreadId: number): Promise<ChatThreadRecord | null> {
    const row = await this.get<{
      id: number;
      chat_id: number;
      message_thread_id: number;
      thinking_enabled: number;
      compact_message: string | null;
      compacted_through_message_id: number | null;
      is_generating: number;
      active_draft_id: number | null;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM chat_threads WHERE chat_id = ? AND message_thread_id = ?', [chatId, messageThreadId]);

    return row ? mapThread(row) : null;
  }

  public async getThreadById(threadId: number): Promise<ChatThreadRecord | null> {
    const row = await this.get<{
      id: number;
      chat_id: number;
      message_thread_id: number;
      thinking_enabled: number;
      compact_message: string | null;
      compacted_through_message_id: number | null;
      is_generating: number;
      active_draft_id: number | null;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM chat_threads WHERE id = ?', [threadId]);

    return row ? mapThread(row) : null;
  }

  public async updateThinkingEnabled(threadId: number, enabled: boolean): Promise<ChatThreadRecord> {
    const updatedAt = nowIso();
    await this.run('UPDATE chat_threads SET thinking_enabled = ?, updated_at = ? WHERE id = ?', [
      enabled ? 1 : 0,
      updatedAt,
      threadId,
    ]);

    const thread = await this.getThreadById(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    return thread;
  }

  public async setGenerationState(threadId: number, isGenerating: boolean, activeDraftId: number | null): Promise<void> {
    await this.run('UPDATE chat_threads SET is_generating = ?, active_draft_id = ?, updated_at = ? WHERE id = ?', [
      isGenerating ? 1 : 0,
      activeDraftId,
      nowIso(),
      threadId,
    ]);
  }

  public async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const parts = normalizeParts(input.parts);

    if (parts.length === 0) {
      throw new Error('Message must include at least one part');
    }

    return this.transaction(async () => {
      const timestamp = nowIso();
      const insertResult = await this.run(
        `
          INSERT INTO messages (
            thread_id,
            role,
            telegram_message_id,
            responded_by_assistant_message_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, NULL, ?, ?)
        `,
        [input.threadId, input.role, input.telegramMessageId ?? null, timestamp, timestamp],
      );

      for (const [index, part] of parts.entries()) {
        await this.run(
          `
            INSERT INTO message_parts (
              message_id,
              part_index,
              type,
              text,
              telegram_file_id,
              media_type
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            insertResult.lastID,
            index,
            part.type,
            part.type === 'text' ? part.text ?? null : null,
            part.type === 'image' ? part.telegramFileId ?? null : null,
            part.type === 'image' ? part.mediaType ?? null : null,
          ],
        );
      }

      const [message] = await this.listMessagesByIds([insertResult.lastID]);
      if (!message) {
        throw new Error('Failed to fetch inserted message');
      }

      return message;
    });
  }

  public async listMessages(threadId: number): Promise<MessageRecord[]> {
    const messageRows = await this.all<{
      id: number;
      thread_id: number;
      role: 'user' | 'assistant';
      telegram_message_id: number | null;
      responded_by_assistant_message_id: number | null;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC', [threadId]);

    if (messageRows.length === 0) {
      return [];
    }

    const partRows = await this.all<{
      id: number;
      message_id: number;
      part_index: number;
      type: 'text' | 'image';
      text: string | null;
      telegram_file_id: string | null;
      media_type: string | null;
    }>(
      `SELECT * FROM message_parts WHERE message_id IN (${messageRows.map(() => '?').join(', ')}) ORDER BY message_id ASC, part_index ASC`,
      messageRows.map((row) => row.id),
    );

    return groupMessages(messageRows, partRows);
  }

  public async listPendingUserMessages(threadId: number): Promise<MessageRecord[]> {
    const messageRows = await this.all<{
      id: number;
      thread_id: number;
      role: 'user' | 'assistant';
      telegram_message_id: number | null;
      responded_by_assistant_message_id: number | null;
      created_at: string;
      updated_at: string;
    }>(
      `
        SELECT *
        FROM messages
        WHERE thread_id = ? AND role = 'user' AND responded_by_assistant_message_id IS NULL
        ORDER BY id ASC
      `,
      [threadId],
    );

    if (messageRows.length === 0) {
      return [];
    }

    const partRows = await this.all<{
      id: number;
      message_id: number;
      part_index: number;
      type: 'text' | 'image';
      text: string | null;
      telegram_file_id: string | null;
      media_type: string | null;
    }>(
      `SELECT * FROM message_parts WHERE message_id IN (${messageRows.map(() => '?').join(', ')}) ORDER BY message_id ASC, part_index ASC`,
      messageRows.map((row) => row.id),
    );

    return groupMessages(messageRows, partRows);
  }

  public async markUserMessagesResponded(userMessageIds: number[], assistantMessageId: number): Promise<void> {
    if (userMessageIds.length === 0) {
      return;
    }

    await this.run(
      `
        UPDATE messages
        SET responded_by_assistant_message_id = ?, updated_at = ?
        WHERE id IN (${userMessageIds.map(() => '?').join(', ')})
      `,
      [assistantMessageId, nowIso(), ...userMessageIds],
    );
  }

  public async updateCompaction(
    threadId: number,
    compactMessage: string,
    throughMessageId: number,
  ): Promise<ChatThreadRecord> {
    await this.run(
      `
        UPDATE chat_threads
        SET compact_message = ?, compacted_through_message_id = ?, updated_at = ?
        WHERE id = ?
      `,
      [compactMessage, throughMessageId, nowIso(), threadId],
    );

    const thread = await this.getThreadById(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    return thread;
  }

  private async listMessagesByIds(messageIds: number[]): Promise<MessageRecord[]> {
    if (messageIds.length === 0) {
      return [];
    }

    const messageRows = await this.all<{
      id: number;
      thread_id: number;
      role: 'user' | 'assistant';
      telegram_message_id: number | null;
      responded_by_assistant_message_id: number | null;
      created_at: string;
      updated_at: string;
    }>(`SELECT * FROM messages WHERE id IN (${messageIds.map(() => '?').join(', ')}) ORDER BY id ASC`, messageIds);

    const partRows = await this.all<{
      id: number;
      message_id: number;
      part_index: number;
      type: 'text' | 'image';
      text: string | null;
      telegram_file_id: string | null;
      media_type: string | null;
    }>(
      `SELECT * FROM message_parts WHERE message_id IN (${messageIds.map(() => '?').join(', ')}) ORDER BY message_id ASC, part_index ASC`,
      messageIds,
    );

    return groupMessages(messageRows, partRows);
  }

  private async exec(sql: string): Promise<void> {
    await this.run(sql, []);
  }

  private async run(sql: string, params: unknown[]): Promise<SqliteRunResult> {
    const db = this.requireDb();
    return new Promise<SqliteRunResult>((resolve, reject) => {
      db.run(sql, params, function handleRun(error) {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          lastID: this.lastID,
          changes: this.changes,
        });
      });
    });
  }

  private async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    const db = this.requireDb();
    return new Promise<T | undefined>((resolve, reject) => {
      db.get(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(row as T | undefined);
      });
    });
  }

  private async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    const db = this.requireDb();
    return new Promise<T[]>((resolve, reject) => {
      db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(rows as T[]);
      });
    });
  }

  private async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const runTransaction = async (): Promise<T> => {
      await this.exec('BEGIN IMMEDIATE');

      try {
        const result = await callback();
        await this.exec('COMMIT');
        return result;
      } catch (error) {
        await this.exec('ROLLBACK');
        throw error;
      }
    };

    const transaction = this.transactionQueue.then(runTransaction, runTransaction);
    this.transactionQueue = transaction.then(
      () => undefined,
      () => undefined,
    );

    return transaction;
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('SQLite database is not initialized');
    }

    return this.db;
  }
}
