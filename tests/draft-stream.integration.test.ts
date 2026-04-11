import { describe, expect, it, vi } from 'vitest';

import { SQLiteRepository } from '../src/db/sqlite.js';
import { ThreadManager } from '../src/queue/thread-manager.js';

describe('thread manager draft streaming', () => {
  it('streams drafts before sending the final message', async () => {
    const repository = new SQLiteRepository(':memory:');
    await repository.initialize();

    const telegram = {
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 999 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 999 })
        .mockResolvedValue({ message_id: 1000 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };

    const ai = {
      async generateReply(input: {
        onText: (text: string) => void;
        onReasoning: (text: string) => void;
      }) {
        input.onReasoning('**step 1**');
        input.onText('# Header\n\n* item');
        await sleep(50);
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
      {
        telegramMessageId: 10,
        parts: [{ type: 'text', text: 'hello' }],
      },
      {
        userName: 'User',
        userLang: 'en',
      },
    );

    await waitFor(() => {
      return (
        telegram.sendMessageDraft.mock.calls.length > 0 &&
        telegram.sendMessage.mock.calls.length >= 2 &&
        telegram.deleteMessage.mock.calls.length > 0
      );
    });

    expect(telegram.sendMessageDraft).toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith({
      chatId: 1,
      messageThreadId: 0,
      text: 'thinking\n',
      parseMode: 'MarkdownV2',
    });
    expect(telegram.sendMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        parseMode: 'MarkdownV2',
      }),
    );
    expect(telegram.sendMessage).toHaveBeenCalledWith({
      chatId: 1,
      messageThreadId: 0,
      text: '*Header*\n\n•   item\n',
      parseMode: 'MarkdownV2',
    });
    expect(telegram.deleteMessage).toHaveBeenCalledWith({
      chatId: 1,
      messageId: 999,
    });

    await repository.close();
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }

    await sleep(25);
  }
}
