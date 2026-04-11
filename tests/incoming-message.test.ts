import { describe, expect, it } from 'vitest';

import {
  extractIncomingEnvelope,
  mergeIncomingEnvelopes,
  shouldWarnUnsupportedMessage,
} from '../src/telegram/incoming-message.js';

describe('incoming Telegram messages', () => {
  it('stores only the largest photo file id', () => {
    const envelope = extractIncomingEnvelope({
      chat: { id: 1, type: 'private' },
      message_id: 99,
      photo: [
        { file_id: 'small', file_size: 100 },
        { file_id: 'large', file_size: 999 },
      ],
      caption: 'look',
    } as never);

    expect(envelope).toEqual({
      telegramMessageId: 99,
      parts: [
        {
          type: 'text',
          text: 'look',
        },
        {
          type: 'image',
          telegramFileId: 'large',
          mediaType: 'image/jpeg',
        },
      ],
    });
  });

  it('merges debounced messages into one internal envelope', () => {
    const merged = mergeIncomingEnvelopes([
      {
        telegramMessageId: 1,
        parts: [{ type: 'text', text: 'one' }],
      },
      {
        telegramMessageId: 2,
        parts: [{ type: 'text', text: 'two' }],
      },
    ]);

    expect(merged.telegramMessageId).toBe(2);
    expect(merged.parts).toEqual([
      { type: 'text', text: 'one\n\n' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('does not warn on service-like topic housekeeping messages', () => {
    expect(
      shouldWarnUnsupportedMessage({
        chat: { id: 1, type: 'private' },
        message_id: 1,
        from: { id: 1, is_bot: false },
        direct_messages_topic: {},
      } as never),
    ).toBe(false);
  });
});
