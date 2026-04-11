import { streamText, type ModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { AppConfig } from './config.js';
import type {
  ChatThreadRecord,
  DatabaseRepository,
  MessagePartRecord,
  MessageRecord,
} from './domain.js';
import { renderSystemPrompt } from './prompt.js';
import { renderMessageForCompaction } from './text.js';
import { TelegramApiClient } from './telegram/api.js';

interface GenerateReplyInput {
  thread: ChatThreadRecord;
  cutoffMessageId: number;
  userName: string;
  userLang: string;
  onText: (text: string) => void;
  onReasoning: (text: string) => void;
}

export class AiService {
  private readonly openRouter;

  public constructor(
    private readonly config: AppConfig,
    private readonly repository: DatabaseRepository,
    private readonly telegram: TelegramApiClient,
  ) {
    this.openRouter = createOpenRouter({
      apiKey: config.openRouterApiKey,
      compatibility: 'strict',
      headers: {
        'X-Title': config.botName,
      },
    });
  }

  public async validateOpenRouterKey(): Promise<void> {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: {
        Authorization: `Bearer ${this.config.openRouterApiKey}`,
      },
    });

    const payload = (await response.json()) as {
      data?: {
        label?: string;
      };
      error?: {
        message?: string;
      };
    };

    if (!response.ok) {
      throw new Error(`OpenRouter key validation failed: ${payload.error?.message ?? response.statusText}`);
    }

    console.log(`OpenRouter key OK: ${payload.data?.label ?? 'unknown key'}`);
  }

  public async generateReply(input: GenerateReplyInput): Promise<string> {
    const compactionWindows = [8, 4];
    console.log(
      `[thread ${input.thread.chatId}:${input.thread.messageThreadId}] starting model generation up to message ${input.cutoffMessageId}`,
    );

    for (let attempt = 0; attempt <= compactionWindows.length; attempt += 1) {
      const currentThread = await this.requireThread(input.thread.id);
      const allMessages = await this.repository.listMessages(currentThread.id);
      const snapshotMessages = allMessages.filter((message) => message.id <= input.cutoffMessageId);
      const system = await renderSystemPrompt({
        config: this.config,
        userName: input.userName,
        userLang: input.userLang,
        thread: currentThread,
      });
      const modelMessages = await this.buildModelMessages(snapshotMessages, currentThread.compactedThroughMessageId);

      try {
        console.log(
          `[thread ${input.thread.chatId}:${input.thread.messageThreadId}] model attempt ${attempt + 1}; raw messages=${snapshotMessages.length}`,
        );
        return await this.streamModel({
          system,
          modelMessages,
          thinkingEnabled: currentThread.thinkingEnabled,
          onText: input.onText,
          onReasoning: input.onReasoning,
        });
      } catch (error) {
        if (!isContextOverflowError(error)) {
          console.error(
            `[thread ${input.thread.chatId}:${input.thread.messageThreadId}] model generation failed without compaction`,
            error,
          );
          throw error;
        }

        const keepNewestRawMessages = compactionWindows[attempt];
        if (keepNewestRawMessages === undefined) {
          throw new Error('Conversation is still too large after compaction');
        }

        console.log(
          `[thread ${input.thread.chatId}:${input.thread.messageThreadId}] context overflow detected; compacting history and keeping newest ${keepNewestRawMessages} raw message(s)`,
        );
        await this.compactHistory(currentThread, snapshotMessages, keepNewestRawMessages);
      }
    }

    throw new Error('Generation failed unexpectedly');
  }

  private async streamModel(input: {
    system: string;
    modelMessages: ModelMessage[];
    thinkingEnabled: boolean;
    onText: (text: string) => void;
    onReasoning: (text: string) => void;
  }): Promise<string> {
    const providerOptions = {
      openrouter: {
        reasoning: input.thinkingEnabled
          ? {
              effort: mapReasoningEffort(this.config.openRouterReasoningEffort),
              exclude: false,
            }
          : {
              effort: mapReasoningEffort(this.config.openRouterReasoningEffort),
              exclude: true,
            },
      },
    };

    const result = streamText({
      model: this.openRouter(this.config.openRouterModel),
      system: input.system,
      messages: input.modelMessages,
      maxRetries: 0,
      providerOptions,
    });

    let answerText = '';
    let reasoningText = '';
    let sawText = false;
    let sawReasoning = false;

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        if (!sawText) {
          console.log('[model] received first text delta');
          sawText = true;
        }
        answerText += part.text;
        input.onText(answerText);
        continue;
      }

      if (part.type === 'reasoning-delta') {
        if (!sawReasoning) {
          console.log('[model] received first reasoning delta');
          sawReasoning = true;
        }
        reasoningText += part.text;
        input.onReasoning(reasoningText);
      }
    }

    const finalText = ((await result.text) || answerText).trim();
    console.log(`[model] stream finished; final text length=${finalText.length}`);
    return finalText.length > 0 ? finalText : 'I could not generate a response.';
  }

  private async buildModelMessages(
    messages: MessageRecord[],
    compactedThroughMessageId: number | null,
  ): Promise<ModelMessage[]> {
    const rawMessages = messages.filter((message) => message.id > (compactedThroughMessageId ?? 0));
    const modelMessages: ModelMessage[] = [];

    for (const message of rawMessages) {
      if (message.role === 'assistant') {
        modelMessages.push({
          role: 'assistant',
          content: renderAssistantText(message),
        });
        continue;
      }

      const content = await Promise.all(
        message.parts.map(async (part) => {
          if (part.type === 'text') {
            return {
              type: 'text' as const,
              text: part.text ?? '',
            };
          }

          const imagePart = {
            type: 'image' as const,
            image: await this.downloadImagePart(part),
          };

          return part.mediaType ? { ...imagePart, mediaType: part.mediaType } : imagePart;
        }),
      );

      if (content.length === 1 && content[0]?.type === 'text') {
        modelMessages.push({
          role: 'user',
          content: content[0].text,
        });
        continue;
      }

      modelMessages.push({
        role: 'user',
        content,
      });
    }

    return modelMessages;
  }

  private async downloadImagePart(part: MessagePartRecord): Promise<Uint8Array> {
    if (!part.telegramFileId) {
      throw new Error(`Image part ${part.id} is missing telegram_file_id`);
    }

    const file = await this.telegram.getFile(part.telegramFileId);
    if (!file.file_path) {
      throw new Error(`Telegram file ${part.telegramFileId} did not include file_path`);
    }

    return this.telegram.downloadFile(file.file_path);
  }

  private async compactHistory(
    thread: ChatThreadRecord,
    messages: MessageRecord[],
    keepNewestRawMessages: number,
  ): Promise<void> {
    const rawMessages = messages.filter((message) => message.id > (thread.compactedThroughMessageId ?? 0));

    if (rawMessages.length <= keepNewestRawMessages) {
      throw new Error('Conversation is too large and cannot be compacted further');
    }

    const messagesToCompact = rawMessages.slice(0, rawMessages.length - keepNewestRawMessages);
    const throughMessageId = messagesToCompact.at(-1)?.id;

    if (!throughMessageId) {
      throw new Error('No messages available for compaction');
    }

    const promptSections = [
      'Rewrite the conversation into a compact memory for future model context.',
      'Preserve user preferences, unresolved tasks, factual constraints, prior commitments, and references to attached images.',
      thread.compactMessage ? `Existing summary:\n${thread.compactMessage}` : '',
      'Conversation to compact:',
      messagesToCompact.map(renderMessageForCompaction).join('\n'),
    ].filter(Boolean);

    const response = await fetch('https://api.morphllm.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.morphApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'morph-compact',
        messages: [
          {
            role: 'user',
            content: promptSections.join('\n\n'),
          },
        ],
      }),
    });

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
      error?: {
        message?: string;
      };
    };

    if (!response.ok) {
      throw new Error(`Morph compaction failed: ${payload.error?.message ?? response.statusText}`);
    }

    const compactMessage = payload.choices?.[0]?.message?.content?.trim();
    if (!compactMessage) {
      throw new Error('Morph compaction returned an empty summary');
    }

    await this.repository.updateCompaction(thread.id, compactMessage, throughMessageId);
  }

  private async requireThread(threadId: number): Promise<ChatThreadRecord> {
    const thread = await this.repository.getThreadById(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    return thread;
  }
}

function mapReasoningEffort(effort: AppConfig['openRouterReasoningEffort']): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
  }
}

function renderAssistantText(message: MessageRecord): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

export function isContextOverflowError(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  const text = collectErrorText(error).toLowerCase();

  if (statusCode === 413) {
    return true;
  }

  return (
    (statusCode === 400 || statusCode === 413) &&
    [
      'context length',
      'history is too long',
      'input is too long',
      'maximum context',
      'prompt is too long',
      'context window',
      'too many tokens',
      'too long',
    ].some((fragment) => text.includes(fragment))
  );
}

function extractStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Record<string, unknown>;
  const status = candidate.statusCode ?? candidate.status ?? candidate.code;

  if (typeof status === 'number') {
    return status;
  }

  if (typeof status === 'string' && /^\d+$/.test(status)) {
    return Number(status);
  }

  if ('cause' in candidate) {
    return extractStatusCode(candidate.cause);
  }

  return null;
}

function collectErrorText(error: unknown, seen = new Set<unknown>()): string {
  if (error === null || error === undefined) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }

  if (typeof error !== 'object' || seen.has(error)) {
    return '';
  }

  seen.add(error);

  const candidate = error as Record<string, unknown>;
  const pieces: string[] = [];

  if (error instanceof Error) {
    pieces.push(error.name, error.message);
  }

  if (typeof candidate.message === 'string') {
    pieces.push(candidate.message);
  }

  if (typeof candidate.description === 'string') {
    pieces.push(candidate.description);
  }

  for (const value of Object.values(candidate)) {
    const nested = collectErrorText(value, seen);
    if (nested) {
      pieces.push(nested);
    }
  }

  return pieces.join(' ');
}
