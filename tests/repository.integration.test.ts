import { afterEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';

import type { DatabaseRepository } from '../src/domain.js';
import { PostgresRepository } from '../src/db/postgres.js';
import { SQLiteRepository } from '../src/db/sqlite.js';

const repositories: DatabaseRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
});

describe('database repositories', () => {
  it('exercises the same repository behavior on sqlite and postgres', async () => {
    const sqlite = new SQLiteRepository(':memory:');
    repositories.push(sqlite);
    await sqlite.initialize();

    const pgMem = newDb();
    const adapter = pgMem.adapters.createPg();
    const pgPool = new adapter.Pool();
    const postgres = new PostgresRepository({
      pool: pgPool as never,
    });
    repositories.push(postgres);
    await postgres.initialize();

    await verifyRepository(sqlite);
    await verifyRepository(postgres);
  });
});

async function verifyRepository(repository: DatabaseRepository): Promise<void> {
  const thread = await repository.getOrCreateThread(100, 5);
  const userMessage = await repository.createMessage({
    threadId: thread.id,
    role: 'user',
    telegramMessageId: 10,
    parts: [
      {
        type: 'text',
        text: 'hello',
      },
      {
        type: 'image',
        telegramFileId: 'telegram-file-id',
        mediaType: 'image/jpeg',
      },
    ],
  });
  const assistantMessage = await repository.createMessage({
    threadId: thread.id,
    role: 'assistant',
    telegramMessageId: 11,
    parts: [
      {
        type: 'text',
        text: 'hi there',
      },
    ],
  });

  await repository.markUserMessagesResponded([userMessage.id], assistantMessage.id);
  const updatedThread = await repository.updateCompaction(thread.id, 'summary', assistantMessage.id);
  const messages = await repository.listMessages(thread.id);
  const pending = await repository.listPendingUserMessages(thread.id);

  expect(updatedThread.compactMessage).toBe('summary');
  expect(updatedThread.compactedThroughMessageId).toBe(assistantMessage.id);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.parts[1]?.telegramFileId).toBe('telegram-file-id');
  expect(pending).toHaveLength(0);
}
