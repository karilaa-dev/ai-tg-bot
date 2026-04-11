import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { renderSystemPrompt } from '../src/prompt.js';

const config: AppConfig = {
  telegramBotToken: 'token',
  openRouterApiKey: 'openrouter',
  openRouterModel: 'anthropic/claude-sonnet-4.5',
  openRouterReasoningEffort: 'medium',
  morphApiKey: 'morph',
  databaseClient: 'sqlite3',
  databaseUrl: null,
  sqliteFilename: ':memory:',
  botName: 'Spec Bot',
  timezone: 'America/Los_Angeles',
  systemPromptPath: '/Users/karilaa/Developer/ai-tg-bot/SYS_PROMPT.md',
};

describe('renderSystemPrompt', () => {
  it('renders prompt placeholders from SYS_PROMPT.md', async () => {
    const prompt = await renderSystemPrompt({
      config,
      userName: 'Test User',
      userLang: 'en',
      thread: {
        id: 1,
        chatId: 100,
        messageThreadId: 0,
        thinkingEnabled: false,
        compactMessage: null,
        compactedThroughMessageId: null,
        isGenerating: false,
        activeDraftId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    expect(prompt).toContain('You are anthropic/claude-sonnet-4.5');
    expect(prompt).toContain('Telegram bot "Spec Bot"');
    expect(prompt).toContain('User: Test User');
    expect(prompt).toContain('User language: en');
  });

  it('appends compact summaries to the system prompt', async () => {
    const prompt = await renderSystemPrompt({
      config,
      userName: 'Test User',
      userLang: 'en',
      thread: {
        id: 1,
        chatId: 100,
        messageThreadId: 0,
        thinkingEnabled: false,
        compactMessage: 'Earlier conversation summary',
        compactedThroughMessageId: 12,
        isGenerating: false,
        activeDraftId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    expect(prompt).toContain('Conversation summary:');
    expect(prompt).toContain('Earlier conversation summary');
  });
});
