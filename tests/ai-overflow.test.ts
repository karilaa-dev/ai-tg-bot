import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { AiService } from '../src/ai.js';

const { streamTextMock, createOpenRouterMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  createOpenRouterMock: vi.fn(() => vi.fn((model: string) => model)),
}));

vi.mock('ai', () => ({
  streamText: streamTextMock,
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: createOpenRouterMock,
}));

const baseConfig: AppConfig = {
  telegramBotToken: 'token',
  openRouterApiKey: 'openrouter',
  openRouterModel: 'anthropic/claude-sonnet-4.5',
  openRouterReasoningEffort: 'medium',
  morphApiKey: 'morph',
  databaseClient: 'sqlite3',
  databaseUrl: null,
  sqliteFilename: ':memory:',
  botName: 'Overflow Bot',
  timezone: 'UTC',
  systemPromptPath: '/Users/karilaa/Developer/ai-tg-bot/SYS_PROMPT.md',
};

describe('AiService compaction', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    createOpenRouterMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('compacts history and retries when the provider reports overflow', async () => {
    const repository = createFakeRepository();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'compacted summary',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    streamTextMock
      .mockImplementationOnce(() => ({
        fullStream: failingStream(Object.assign(new Error('context length exceeded'), { statusCode: 400 })),
      }))
      .mockImplementationOnce(() => ({
        fullStream: successfulTextStream('final answer'),
      }));

    const ai = new AiService(baseConfig, repository as never, {
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    } as never);

    const textUpdates: string[] = [];
    const result = await ai.generateReply({
      thread: repository.thread,
      cutoffMessageId: 10,
      userName: 'User',
      userLang: 'en',
      onText: (text) => {
        textUpdates.push(text);
      },
      onReasoning: vi.fn(),
    });

    expect(result).toBe('final answer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.thread.compactMessage).toBe('compacted summary');
    expect(repository.thread.compactedThroughMessageId).toBe(2);
    expect(textUpdates.at(-1)).toBe('final answer');
  });
});

function createFakeRepository() {
  const thread: {
    id: number;
    chatId: number;
    messageThreadId: number;
    thinkingEnabled: boolean;
    compactMessage: string | null;
    compactedThroughMessageId: number | null;
    isGenerating: boolean;
    activeDraftId: number | null;
    createdAt: string;
    updatedAt: string;
  } = {
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
  };

  const messages = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    threadId: 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    telegramMessageId: index + 100,
    respondedByAssistantMessageId: index % 2 === 0 ? index + 2 : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parts: [
      {
        id: index + 1,
        messageId: index + 1,
        partIndex: 0,
        type: 'text' as const,
        text: `message ${index + 1}`,
        telegramFileId: null,
        mediaType: null,
      },
    ],
  }));

  return {
    thread,
    async initialize() {},
    async close() {},
    async getOrCreateThread() {
      return thread;
    },
    async getThreadByKey() {
      return thread;
    },
    async getThreadById() {
      return thread;
    },
    async updateThinkingEnabled() {
      return thread;
    },
    async setGenerationState() {},
    async createMessage() {
      throw new Error('not needed');
    },
    async listMessages() {
      return messages;
    },
    async listPendingUserMessages() {
      return messages.filter((message) => message.role === 'user');
    },
    async markUserMessagesResponded() {},
    async updateCompaction(threadId: number, compactMessage: string, throughMessageId: number) {
      expect(threadId).toBe(1);
      thread.compactMessage = compactMessage;
      thread.compactedThroughMessageId = throughMessageId;
      return thread;
    },
  };
}

async function* failingStream(error: Error & { statusCode: number }): AsyncGenerator<never> {
  throw error;
}

async function* successfulTextStream(
  text: string,
): AsyncGenerator<{ type: 'text-delta'; text: string; id: string }> {
  yield {
    type: 'text-delta',
    id: 'text-1',
    text,
  };
}
