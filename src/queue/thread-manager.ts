import type { DatabaseRepository, IncomingEnvelope, ThreadKey } from '../domain.js';
import { makeThreadKey } from '../threading.js';
import { TelegramApiClient } from '../telegram/api.js';
import { DraftStreamSession } from '../telegram/draft-stream.js';
import type { UserMetadata } from '../telegram/incoming-message.js';
import { sendTelegramMarkdownMessage, splitTelegramMarkdown } from '../telegram/outbound.js';
import { mergeIncomingEnvelopes } from '../telegram/incoming-message.js';
import { AiService } from '../ai.js';

interface ThreadControllerDependencies {
  repository: DatabaseRepository;
  telegram: TelegramApiClient;
  ai: AiService;
}

class ThreadController {
  private buffer: IncomingEnvelope[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;
  private startingLoop = false;
  private lastUserMetadata: UserMetadata = {
    userName: 'Telegram User',
    userLang: 'unknown',
  };
  private readonly debounceMs = 100;

  public constructor(
    private readonly thread: ThreadKey,
    private readonly deps: ThreadControllerDependencies,
  ) {}

  public async enqueue(envelope: IncomingEnvelope, metadata: UserMetadata): Promise<void> {
    this.lastUserMetadata = metadata;
    logThread(this.thread, `enqueue message ${envelope.telegramMessageId} with ${envelope.parts.length} part(s)`);

    if (this.runPromise || this.startingLoop) {
      logThread(this.thread, `thread busy, persisting message ${envelope.telegramMessageId} directly`);
      await this.persistEnvelope(envelope);
      return;
    }

    if (this.buffer.length === 0) {
      void this.deps.telegram.sendChatAction({
        chatId: this.thread.chatId,
        messageThreadId: this.thread.messageThreadId,
        action: 'typing',
      }).catch((error) => {
        console.error('Initial sendChatAction failed', error);
      });
      logThread(this.thread, 'sent initial typing indicator');
    }

    this.buffer.push(envelope);
    logThread(this.thread, `buffered message ${envelope.telegramMessageId}; buffer size=${this.buffer.length}`);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushBuffer();
    }, this.debounceMs);
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const batch = this.buffer;
    this.buffer = [];
    this.startingLoop = true;
    logThread(this.thread, `flushing debounce buffer with ${batch.length} message(s)`);

    try {
      await this.persistEnvelope(mergeIncomingEnvelopes(batch));
      this.startRunLoop();
    } finally {
      this.startingLoop = false;
    }
  }

  private startRunLoop(): void {
    if (this.runPromise) {
      return;
    }

    logThread(this.thread, 'starting processing loop');
    const promise = this.runLoop().catch((error) => {
      if (isRepositoryClosedError(error)) {
        logThread(this.thread, 'processing loop stopped because repository is closed');
        return;
      }

      throw error;
    });
    this.runPromise = promise;
    void promise.finally(async () => {
      try {
        if (this.runPromise !== promise) {
          return;
        }

        this.runPromise = null;
        const thread = await this.deps.repository.getThreadByKey(this.thread.chatId, this.thread.messageThreadId);

        if (thread) {
          const pendingMessages = await this.deps.repository.listPendingUserMessages(thread.id);
          logThread(this.thread, `processing loop finished; pending messages=${pendingMessages.length}`);
          if (pendingMessages.length > 0) {
            this.startRunLoop();
            return;
          }
        }

        if (this.buffer.length > 0) {
          void this.flushBuffer();
        }
      } catch (error) {
        if (isRepositoryClosedError(error)) {
          logThread(this.thread, 'processing loop cleanup skipped because repository is closed');
          return;
        }

        console.error('Thread processing loop cleanup failed', error);
      }
    });
  }

  private async runLoop(): Promise<void> {
    const thread = await this.deps.repository.getOrCreateThread(this.thread.chatId, this.thread.messageThreadId);

    while (true) {
      const allMessages = await this.deps.repository.listMessages(thread.id);
      const cutoffMessageId = allMessages.at(-1)?.id;
      if (!cutoffMessageId) {
        return;
      }

      const pendingMessageIds = allMessages
        .filter((message) => message.role === 'user' && message.respondedByAssistantMessageId === null)
        .map((message) => message.id);

      if (pendingMessageIds.length === 0) {
        logThread(this.thread, 'no pending messages left');
        return;
      }

      logThread(this.thread, `generating reply for pending message ids: ${pendingMessageIds.join(', ')}`);

      const baseDraftId = createDraftId();
      const currentThread = await this.deps.repository.getThreadById(thread.id);
      if (!currentThread) {
        throw new Error(`Thread ${thread.id} not found`);
      }

      const draftSession = new DraftStreamSession(this.deps.telegram, {
        chatId: currentThread.chatId,
        messageThreadId: currentThread.messageThreadId,
        baseDraftId,
        reasoningEnabled: currentThread.thinkingEnabled,
        statusText: currentThread.thinkingEnabled ? 'thinking' : 'thinking',
        actionText: 'typing',
      });

      await draftSession.start();
      logThread(this.thread, `draft session started with baseDraftId=${baseDraftId}`);
      await this.deps.repository.setGenerationState(thread.id, true, baseDraftId);

      try {
        const assistantText = await this.deps.ai.generateReply({
          thread: currentThread,
          cutoffMessageId,
          userName: this.lastUserMetadata.userName,
          userLang: this.lastUserMetadata.userLang,
          onText: (text) => {
            draftSession.updateAnswer(text);
          },
          onReasoning: (text) => {
            draftSession.updateReasoning(text);
          },
        });
        logThread(this.thread, `generation completed; response length=${assistantText.length}`);

        const sentMessageIds = await this.sendFinalReply(currentThread.chatId, currentThread.messageThreadId, assistantText);
        logThread(this.thread, `sent final reply message ids: ${sentMessageIds.join(', ')}`);
        const assistantRecord = await this.deps.repository.createMessage({
          threadId: currentThread.id,
          role: 'assistant',
          telegramMessageId: sentMessageIds.at(-1) ?? null,
          parts: [
            {
              type: 'text',
              text: assistantText,
            },
          ],
        });

        await this.deps.repository.markUserMessagesResponded(pendingMessageIds, assistantRecord.id);
        logThread(this.thread, `marked pending messages handled by assistant message ${assistantRecord.id}`);
      } catch (error) {
        console.error('Generation failed', error);
        const errorText = 'I hit an internal error while generating a reply. Send another message to try again.';
        const sentErrorMessage = await sendTelegramMarkdownMessage(this.deps.telegram, {
          chatId: currentThread.chatId,
          messageThreadId: currentThread.messageThreadId,
          text: errorText,
        });
        const assistantRecord = await this.deps.repository.createMessage({
          threadId: currentThread.id,
          role: 'assistant',
          telegramMessageId: sentErrorMessage.message_id,
          parts: [
            {
              type: 'text',
              text: errorText,
            },
          ],
        });
        await this.deps.repository.markUserMessagesResponded(pendingMessageIds, assistantRecord.id);
        logThread(this.thread, `recorded failure reply ${assistantRecord.id} and cleared pending messages`);
        return;
      } finally {
        await draftSession.stop();
        await this.deps.repository.setGenerationState(thread.id, false, null);
        logThread(this.thread, 'draft session stopped and generation state cleared');
      }
    }
  }

  private async persistEnvelope(envelope: IncomingEnvelope): Promise<void> {
    const thread = await this.deps.repository.getOrCreateThread(this.thread.chatId, this.thread.messageThreadId);

    const message = await this.deps.repository.createMessage({
      threadId: thread.id,
      role: 'user',
      telegramMessageId: envelope.telegramMessageId,
      parts: envelope.parts,
    });
    logThread(this.thread, `persisted user message ${message.id} from telegram message ${envelope.telegramMessageId}`);
  }

  private async sendFinalReply(chatId: number, messageThreadId: number, text: string): Promise<number[]> {
    const chunks = splitTelegramMarkdown(text);
    const sentMessageIds: number[] = [];

    for (const chunk of chunks) {
      const sent = await sendTelegramMarkdownMessage(this.deps.telegram, {
        chatId,
        messageThreadId,
        text: chunk.rawText,
      });
      sentMessageIds.push(sent.message_id);
    }

    return sentMessageIds;
  }
}

export class ThreadManager {
  private readonly controllers = new Map<string, ThreadController>();

  public constructor(private readonly deps: ThreadControllerDependencies) {}

  public async enqueue(thread: ThreadKey, envelope: IncomingEnvelope, metadata: UserMetadata): Promise<void> {
    const controller = this.getController(thread);
    await controller.enqueue(envelope, metadata);
  }

  private getController(thread: ThreadKey): ThreadController {
    const key = makeThreadKey(thread);
    const existing = this.controllers.get(key);
    if (existing) {
      return existing;
    }

    const created = new ThreadController(thread, this.deps);
    this.controllers.set(key, created);
    return created;
  }
}

function createDraftId(): number {
  return Math.floor(Date.now() % 1_000_000_000) * 10 + Math.floor(Math.random() * 10);
}

function logThread(thread: ThreadKey, message: string): void {
  console.log(`[thread ${thread.chatId}:${thread.messageThreadId}] ${message}`);
}

function isRepositoryClosedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('database is not initialized');
}
