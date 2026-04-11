import { describe, expect, it, vi } from 'vitest';
import { Bot } from 'grammy';

import { registerCommands } from '../src/commands.js';
import { SQLiteRepository } from '../src/db/sqlite.js';

describe('/thinking command', () => {
  it('toggles thinking per thread', async () => {
    const repository = new SQLiteRepository(':memory:');
    await repository.initialize();

    const telegram = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    };

    const bot = new Bot('123456:ABC', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'TestBot',
        username: 'test_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_manage_bots: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: true,
        allows_users_to_create_topics: false,
      },
    });
    registerCommands(bot, {
      repository,
      telegram: telegram as never,
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: '/thinking on',
        entities: [
          {
            offset: 0,
            length: 9,
            type: 'bot_command',
          },
        ],
        chat: {
          id: 10,
          type: 'private',
        },
        from: {
          id: 20,
          is_bot: false,
          first_name: 'Test',
          language_code: 'en',
        },
      },
    } as never);

    const thread = await repository.getOrCreateThread(10, 0);
    expect(thread.thinkingEnabled).toBe(true);
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parseMode: 'MarkdownV2',
      }),
    );

    await repository.close();
  });
});
