import { config as loadDotenv } from 'dotenv';

import { Bot, type Context } from 'grammy';

import { AiService } from './ai.js';
import { registerCommands } from './commands.js';
import { loadConfig } from './config.js';
import { createRepository } from './db/index.js';
import { ThreadManager } from './queue/thread-manager.js';
import { TelegramApiClient } from './telegram/api.js';
import {
  extractIncomingEnvelope,
  extractUserMetadata,
  isSupportedChatType,
  resolveThreadKey,
  shouldWarnUnsupportedMessage,
} from './telegram/incoming-message.js';
import { sendTelegramMarkdownMessage } from './telegram/outbound.js';

async function main(): Promise<void> {
  loadDotenv({ override: true });

  const config = loadConfig();
  const repository = createRepository(config);
  await repository.initialize();

  const telegram = new TelegramApiClient(config.telegramBotToken);
  const ai = new AiService(config, repository, telegram);
  await ai.validateOpenRouterKey();
  const threadManager = new ThreadManager({
    repository,
    telegram,
    ai,
  });

  const bot = new Bot<Context>(config.telegramBotToken);
  registerCommands(bot, {
    repository,
    telegram,
  });

  bot.on('message', async (ctx) => {
    if (!ctx.msg) {
      return;
    }

    const message = ctx.msg as never;

    if (!isSupportedChatType(message)) {
      await sendTelegramMarkdownMessage(telegram, {
        chatId: Number(ctx.chat?.id ?? 0),
        text: 'This bot currently supports private chats and private chat topics only.',
      });
      return;
    }

    const text = 'text' in (message as Record<string, unknown>) ? String((message as Record<string, unknown>).text ?? '') : '';
    if (text.startsWith('/')) {
      return;
    }

    const envelope = extractIncomingEnvelope(message);
    const thread = resolveThreadKey(message);

    if (!envelope) {
      if (shouldWarnUnsupportedMessage(message)) {
        await sendTelegramMarkdownMessage(telegram, {
          chatId: thread.chatId,
          messageThreadId: thread.messageThreadId,
          text: 'Unsupported message type. Send text, a photo, or an image document.',
        });
      }
      return;
    }

    await threadManager.enqueue(thread, envelope, extractUserMetadata(message));
  });

  bot.catch((error) => {
    console.error('Telegram bot error', error.error);
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`Received ${signal}, shutting down`);
    await bot.stop();
    await repository.close();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await bot.start({
    onStart: (botInfo) => {
      console.log(`Bot started as @${botInfo.username}`);
    },
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
