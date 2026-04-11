import { describe, expect, it } from 'vitest';

import { makeThreadKey } from '../src/threading.js';
import { resolveThreadKey } from '../src/telegram/incoming-message.js';

describe('threading', () => {
  it('creates stable thread keys for private chats and topics', () => {
    expect(makeThreadKey({ chatId: 42, messageThreadId: 0 })).toBe('42:0');
    expect(makeThreadKey({ chatId: 42, messageThreadId: 7 })).toBe('42:7');
  });

  it('resolves missing thread ids to the default thread', () => {
    expect(
      resolveThreadKey({
        chat: { id: 12, type: 'private' },
        message_id: 10,
      } as never),
    ).toEqual({
      chatId: 12,
      messageThreadId: 0,
    });
  });

  it('resolves explicit topic ids', () => {
    expect(
      resolveThreadKey({
        chat: { id: 12, type: 'private' },
        message_id: 10,
        message_thread_id: 55,
      } as never),
    ).toEqual({
      chatId: 12,
      messageThreadId: 55,
    });
  });
});
