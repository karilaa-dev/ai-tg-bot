import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramApiClient } from '../src/telegram/api.js';

describe('TelegramApiClient parse_mode support', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes parse_mode for sendMessage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 1,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const telegram = new TelegramApiClient('token');
    await telegram.sendMessage({
      chatId: 10,
      messageThreadId: 20,
      text: 'hello',
      parseMode: 'MarkdownV2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: 10,
          message_thread_id: 20,
          text: 'hello',
          parse_mode: 'MarkdownV2',
        }),
      }),
    );
  });

  it('passes parse_mode for sendMessageDraft', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: true,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const telegram = new TelegramApiClient('token');
    await telegram.sendMessageDraft({
      chatId: 10,
      messageThreadId: 20,
      draftId: 30,
      text: 'hello',
      parseMode: 'MarkdownV2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken/sendMessageDraft',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: 10,
          message_thread_id: 20,
          draft_id: 30,
          text: 'hello',
          parse_mode: 'MarkdownV2',
        }),
      }),
    );
  });
});
