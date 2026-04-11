import { describe, expect, it, vi } from 'vitest';

import { TelegramApiError } from '../src/telegram/api.js';
import {
  createTelegramMarkdownPreview,
  editTelegramMarkdownMessage,
  sendTelegramMarkdownDraft,
  sendTelegramMarkdownMessage,
  splitTelegramMarkdown,
} from '../src/telegram/outbound.js';

describe('telegram outbound formatting', () => {
  it('formats markdown into Telegram MarkdownV2 payloads', () => {
    const [chunk] = splitTelegramMarkdown('# Header\n\n[link](https://example.com)\n\n* item');

    expect(chunk).toEqual({
      rawText: '# Header\n\n[link](https://example.com)\n\n* item',
      text: '*Header*\n\n[link](https://example.com)\n\n•   item\n',
      parseMode: 'MarkdownV2',
    });
  });

  it('keeps partial markdown best-effort for previews', () => {
    const preview = createTelegramMarkdownPreview('**bold');

    expect(preview.parseMode).toBe('MarkdownV2');
    expect(preview.text).toBe('\\*\\*bold\n');
  });

  it('rewrites markdown tables into fenced code blocks', () => {
    const [chunk] = splitTelegramMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');

    if (!chunk) {
      throw new Error('Expected at least one chunk');
    }
    expect(chunk.parseMode).toBe('MarkdownV2');
    expect(chunk.text).toBe('```\na | b\n1 | 2\n```\n');
  });

  it('escapes unsupported markdown so Telegram can still render the rest', () => {
    const [chunk] = splitTelegramMarkdown('---\n\n- [x] done');

    if (!chunk) {
      throw new Error('Expected at least one chunk');
    }
    expect(chunk.parseMode).toBe('MarkdownV2');
    expect(chunk.text).toContain('\\-\\-\\-');
    expect(chunk.text).toContain('•   done');
  });

  it('splits long markdown replies into Telegram-sized chunks', () => {
    const longMarkdown = `## Section\n\n${'word '.repeat(830).trim()}`;

    const chunks = splitTelegramMarkdown(longMarkdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.parseMode === 'MarkdownV2')).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 4096)).toBe(true);
  }, 30000);

  it('splits oversized fenced code blocks into balanced chunks', () => {
    const longFence = `\`\`\`js\n${Array.from({ length: 1200 }, (_, index) => `line ${index}`).join('\n')}\n\`\`\``;

    const chunks = splitTelegramMarkdown(longFence);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.rawText.startsWith('```js\n'))).toBe(true);
    expect(chunks.every((chunk) => chunk.rawText.endsWith('```'))).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 4096)).toBe(true);
  }, 30000);
});

describe('telegram outbound fallbacks', () => {
  it('retries message sends as plain text when formatted payloads are rejected', async () => {
    const telegram = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new TelegramApiError('parse failed', 400))
        .mockResolvedValueOnce({ message_id: 1 }),
    };

    const result = await sendTelegramMarkdownMessage(telegram as never, {
      chatId: 1,
      messageThreadId: 2,
      text: '# Header',
    });

    expect(result).toEqual({ message_id: 1 });
    expect(telegram.sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        parseMode: 'MarkdownV2',
        text: '*Header*\n',
      }),
    );
    expect(telegram.sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: 1,
      messageThreadId: 2,
      text: '# Header',
    });
  });

  it('retries draft sends as plain text when formatted payloads are rejected', async () => {
    const telegram = {
      sendMessageDraft: vi
        .fn()
        .mockRejectedValueOnce(new TelegramApiError('parse failed', 400))
        .mockResolvedValueOnce(true),
    };

    const result = await sendTelegramMarkdownDraft(telegram as never, {
      chatId: 1,
      messageThreadId: 2,
      draftId: 3,
      text: '# Header',
    });

    expect(result).toBe(true);
    expect(telegram.sendMessageDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        draftId: 3,
        parseMode: 'MarkdownV2',
        text: '*Header*\n',
      }),
    );
    expect(telegram.sendMessageDraft).toHaveBeenNthCalledWith(2, {
      chatId: 1,
      messageThreadId: 2,
      draftId: 3,
      text: '# Header',
    });
  });

  it('retries message edits as plain text when formatted payloads are rejected', async () => {
    const telegram = {
      editMessageText: vi
        .fn()
        .mockRejectedValueOnce(new TelegramApiError('parse failed', 400))
        .mockResolvedValueOnce({ message_id: 4 }),
    };

    const result = await editTelegramMarkdownMessage(telegram as never, {
      chatId: 1,
      messageId: 4,
      text: '**bold',
    });

    expect(result).toEqual({ message_id: 4 });
    expect(telegram.editMessageText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        parseMode: 'MarkdownV2',
        text: '\\*\\*bold\n',
      }),
    );
    expect(telegram.editMessageText).toHaveBeenNthCalledWith(2, {
      chatId: 1,
      messageId: 4,
      text: '**bold',
    });
  });
});
