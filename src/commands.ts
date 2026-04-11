import type { Bot, Context } from 'grammy';

import type { DatabaseRepository } from './domain.js';
import { TelegramApiClient } from './telegram/api.js';
import { extractUserMetadata, isSupportedChatType, resolveThreadKey } from './telegram/incoming-message.js';
import { sendTelegramMarkdownMessage } from './telegram/outbound.js';

interface CommandDependencies {
  repository: DatabaseRepository;
  telegram: TelegramApiClient;
}

export function registerCommands(bot: Bot<Context>, deps: CommandDependencies): void {
  bot.command('start', async (ctx) => {
    if (!ctx.msg || !isSupportedChatType(ctx.msg as never)) {
      if (ctx.chat?.id) {
        await sendTelegramMarkdownMessage(deps.telegram, {
          chatId: Number(ctx.chat.id),
          text: 'This bot currently supports private chats and private chat topics only.',
        });
      }
      return;
    }

    const thread = resolveThreadKey(ctx.msg as never);
    await deps.repository.getOrCreateThread(thread.chatId, thread.messageThreadId);
    await sendTelegramMarkdownMessage(deps.telegram, {
      chatId: thread.chatId,
      messageThreadId: thread.messageThreadId,
      text:
        'Send text or images in a private chat or a private chat topic. Use /thinking on or /thinking off to toggle visible reasoning for this thread.',
    });
  });

  bot.command('thinking', async (ctx) => {
    if (!ctx.msg || !isSupportedChatType(ctx.msg as never)) {
      if (ctx.chat?.id) {
        await sendTelegramMarkdownMessage(deps.telegram, {
          chatId: Number(ctx.chat.id),
          text: 'This command only works in private chats and private chat topics.',
        });
      }
      return;
    }

    const message = ctx.msg as never;
    const thread = resolveThreadKey(message);
    const currentThread = await deps.repository.getOrCreateThread(thread.chatId, thread.messageThreadId);
    const text = 'text' in (message as Record<string, unknown>) ? String((message as Record<string, unknown>).text ?? '') : '';
    const [, rawArgument = ''] = text.trim().split(/\s+/, 2);
    const argument = rawArgument.toLowerCase();

    if (!argument) {
      await sendTelegramMarkdownMessage(deps.telegram, {
        chatId: thread.chatId,
        messageThreadId: thread.messageThreadId,
        text: `Thinking is currently ${currentThread.thinkingEnabled ? 'on' : 'off'} for this thread.`,
      });
      return;
    }

    if (argument !== 'on' && argument !== 'off') {
      await sendTelegramMarkdownMessage(deps.telegram, {
        chatId: thread.chatId,
        messageThreadId: thread.messageThreadId,
        text: 'Usage: /thinking on or /thinking off',
      });
      return;
    }

    const updated = await deps.repository.updateThinkingEnabled(currentThread.id, argument === 'on');
    const metadata = extractUserMetadata(message);
    await sendTelegramMarkdownMessage(deps.telegram, {
      chatId: thread.chatId,
      messageThreadId: thread.messageThreadId,
      text: `Thinking is now ${updated.thinkingEnabled ? 'on' : 'off'} for this thread, ${metadata.userName}.`,
    });
  });
}
