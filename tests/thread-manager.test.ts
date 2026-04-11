import { describe, expect, it, vi } from 'vitest';

import { SQLiteRepository } from '../src/db/sqlite.js';
import { ThreadManager } from '../src/queue/thread-manager.js';

describe('ThreadManager', () => {
  it('debounces idle messages into one stored user message', async () => {
    const repository = new SQLiteRepository(':memory:');
    await repository.initialize();

    const telegram = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 99 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 99 })
        .mockResolvedValue({ message_id: 100 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const ai = {
      async generateReply() {
        return '# Header\n\n* item';
      },
    };
    const manager = new ThreadManager({
      repository,
      telegram: telegram as never,
      ai: ai as never,
    });

    await manager.enqueue(
      { chatId: 1, messageThreadId: 0 },
      { telegramMessageId: 1, parts: [{ type: 'text', text: 'one' }] },
      { userName: 'User', userLang: 'en' },
    );
    await manager.enqueue(
      { chatId: 1, messageThreadId: 0 },
      { telegramMessageId: 2, parts: [{ type: 'text', text: 'two' }] },
      { userName: 'User', userLang: 'en' },
    );

    await waitFor(
      asyncCondition(
        () => repository.getOrCreateThread(1, 0).then((thread) => repository.listMessages(thread.id)),
        (messages) => messages.filter((message) => message.role === 'assistant').length === 1,
      ),
    );

    const thread = await repository.getOrCreateThread(1, 0);
    const messages = await repository.listMessages(thread.id);
    const userMessages = messages.filter((message) => message.role === 'user');

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts.map((part) => part.text).join('')).toContain('one');
    expect(userMessages[0]?.parts.map((part) => part.text).join('')).toContain('two');
    expect(telegram.sendMessage).toHaveBeenCalledWith({
      chatId: 1,
      messageThreadId: 0,
      text: '*Header*\n\n•   item\n',
      parseMode: 'MarkdownV2',
    });

    await repository.close();
  });

  it('queues busy-thread messages separately and restarts once for the latest pending batch', async () => {
    const repository = new SQLiteRepository(':memory:');
    await repository.initialize();

    const telegram = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 99 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 99 })
        .mockResolvedValue({ message_id: 100 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };

    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const calls: number[] = [];
    let secondStartedResolve: (() => void) | null = null;
    const secondStarted = new Promise<void>((resolve) => {
      secondStartedResolve = resolve;
    });

    const ai = {
      async generateReply() {
        calls.push(Date.now());
        if (calls.length === 1) {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }

        secondStartedResolve?.();
        return new Promise<string>((resolve) => {
          resolveSecond = resolve;
        });
      },
    };

    const manager = new ThreadManager({
      repository,
      telegram: telegram as never,
      ai: ai as never,
    });

    await manager.enqueue(
      { chatId: 1, messageThreadId: 0 },
      { telegramMessageId: 1, parts: [{ type: 'text', text: 'first' }] },
      { userName: 'User', userLang: 'en' },
    );
    await waitFor(() => telegram.sendMessage.mock.calls.length >= 1);

    await manager.enqueue(
      { chatId: 1, messageThreadId: 0 },
      { telegramMessageId: 2, parts: [{ type: 'text', text: 'second' }] },
      { userName: 'User', userLang: 'en' },
    );
    await manager.enqueue(
      { chatId: 1, messageThreadId: 0 },
      { telegramMessageId: 3, parts: [{ type: 'text', text: 'third' }] },
      { userName: 'User', userLang: 'en' },
    );

    resolveFirst('# First');
    await secondStarted;

    expect(calls).toHaveLength(2);

    resolveSecond('# Second');
    await waitFor(asyncCondition(() => repository.getOrCreateThread(1, 0).then((thread) => repository.listMessages(thread.id)), (messages) => {
      return messages.filter((message) => message.role === 'assistant').length === 2;
    }));

    const thread = await repository.getOrCreateThread(1, 0);
    const messages = await repository.listMessages(thread.id);

    expect(messages.filter((message) => message.role === 'user')).toHaveLength(3);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2);

    await repository.close();
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }

    await sleep(25);
  }
}

function asyncCondition<T>(load: () => Promise<T>, predicate: (value: T) => boolean): () => Promise<boolean> {
  return async () => predicate(await load());
}
