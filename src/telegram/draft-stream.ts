import { TelegramApiClient, TelegramApiError } from './api.js';
import {
  createTelegramMarkdownPreview,
  editTelegramMarkdownMessage,
  sendTelegramMarkdownDraft,
  sendTelegramMarkdownMessage,
} from './outbound.js';

interface DraftStreamOptions {
  chatId: number;
  messageThreadId: number;
  baseDraftId: number;
  reasoningEnabled: boolean;
  statusText?: string;
  actionText?: string;
  flushIntervalMs?: number;
  placeholderIntervalMs?: number;
  actionIntervalMs?: number;
}

export class DraftStreamSession {
  private readonly answerDraftId: number;
  private readonly flushIntervalMs: number;
  private readonly placeholderIntervalMs: number;
  private readonly actionIntervalMs: number;

  private answerText = '';
  private statusText: string;
  private lastSentAnswerText = '';
  private lastSentStatusText = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private placeholderTimer: NodeJS.Timeout | null = null;
  private actionTimer: NodeJS.Timeout | null = null;
  private flushInFlight = false;
  private reasoningVisible = false;
  private stopped = false;
  private temporaryStatusMessageId: number | null = null;
  private lastTemporaryStatusText = '';
  private temporaryStatusRevision = 0;
  private typingHeartbeatEnabled = false;
  private scheduledFlushAt: number | null = null;
  private nextDraftAllowedAt = 0;
  private nextStatusAllowedAt = 0;
  private nextActionAllowedAt = 0;
  private nextTelegramAllowedAt = 0;
  private lastDraftRateLimitLogAt = 0;
  private lastStatusRateLimitLogAt = 0;
  private lastActionRateLimitLogAt = 0;

  public constructor(
    private readonly telegram: TelegramApiClient,
    private readonly options: DraftStreamOptions,
  ) {
    this.answerDraftId = options.baseDraftId;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.placeholderIntervalMs = options.placeholderIntervalMs ?? 2500;
    this.actionIntervalMs = options.actionIntervalMs ?? 4500;
    this.statusText = options.statusText ?? 'thinking';
  }

  public async start(): Promise<void> {
    await this.ensureTemporaryStatusMessage();
    this.typingHeartbeatEnabled = this.temporaryStatusMessageId === null;
    if (this.typingHeartbeatEnabled) {
      this.startTypingHeartbeat();
    }
    this.startPlaceholder();
    await this.flush();
  }

  public updateAnswer(text: string): void {
    this.answerText = text;
    this.scheduleFlush(this.lastSentAnswerText.length === 0 ? 0 : this.flushIntervalMs);
  }

  public updateReasoning(text: string): void {
    const wasVisible = this.reasoningVisible;
    this.reasoningVisible = text.trim().length > 0;

    if (this.reasoningVisible) {
      this.stopPlaceholder();
      this.statusText = text;
      this.scheduleFlush(!wasVisible ? 0 : this.flushIntervalMs);
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.stopPlaceholder();
    this.stopTypingHeartbeat();

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.scheduledFlushAt = null;
    }

    await this.flush();
    await this.deleteTemporaryStatusMessage();
  }

  private startPlaceholder(): void {
    if (this.options.reasoningEnabled && this.reasoningVisible) {
      return;
    }

    const base = this.options.statusText ?? 'thinking';
    const frames = [base, `${base}.`, `${base}..`, `${base}...`];
    let index = 0;
    this.statusText = frames[index]!;

    this.placeholderTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }

      if (this.options.reasoningEnabled && this.reasoningVisible) {
        return;
      }

      index = (index + 1) % frames.length;
      this.statusText = frames[index]!;
      this.scheduleFlush(this.placeholderIntervalMs);
    }, this.placeholderIntervalMs);
  }

  private stopPlaceholder(): void {
    if (!this.placeholderTimer) {
      return;
    }

    clearInterval(this.placeholderTimer);
    this.placeholderTimer = null;
  }

  private startTypingHeartbeat(): void {
    if (this.actionTimer) {
      return;
    }

    void this.sendTypingSafe();

    this.actionTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }

      void this.sendTypingSafe();
    }, this.actionIntervalMs);
  }

  private stopTypingHeartbeat(): void {
    if (!this.actionTimer) {
      return;
    }

    clearInterval(this.actionTimer);
    this.actionTimer = null;
  }

  private scheduleFlush(delayMs = this.flushIntervalMs): void {
    if (this.stopped) {
      return;
    }

    const delay = Math.max(0, delayMs);
    const scheduledAt = Date.now() + delay;

    if (this.flushTimer && this.scheduledFlushAt !== null && this.scheduledFlushAt <= scheduledAt) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.scheduledFlushAt = scheduledAt;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.scheduledFlushAt = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.flushInFlight) {
      return;
    }

    this.flushInFlight = true;

    try {
      const now = Date.now();

      if (now < this.nextTelegramAllowedAt) {
        return;
      }

      const hasPendingAnswer = this.answerText.length > 0 && this.answerText !== this.lastSentAnswerText;
      const hasPendingStatus = this.statusText.length > 0 && this.statusText !== this.lastSentStatusText;

      if (hasPendingAnswer && now >= this.nextDraftAllowedAt) {
        const nextText = createTelegramMarkdownPreview(this.answerText);
        const sent = await this.sendDraftSafe(this.answerDraftId, nextText);
        if (sent) {
          this.lastSentAnswerText = this.answerText;
        }
        return;
      }

      if (hasPendingStatus && now >= this.nextStatusAllowedAt) {
        const nextText = createTelegramMarkdownPreview(this.statusText);
        const sent = await this.updateTemporaryStatusMessage(nextText);
        if (sent) {
          this.lastSentStatusText = this.statusText;
        }
      }
    } finally {
      this.flushInFlight = false;

      if (!this.stopped && (this.hasPendingAnswer() || this.hasPendingStatus())) {
        this.scheduleFlush(this.getNextFlushDelay());
      }
    }
  }

  private async sendDraftSafe(draftId: number, preview: ReturnType<typeof createTelegramMarkdownPreview>): Promise<boolean> {
    try {
      await sendTelegramMarkdownDraft(this.telegram, {
        chatId: this.options.chatId,
        messageThreadId: this.options.messageThreadId,
        draftId,
        text: preview.rawText,
      });
      this.nextDraftAllowedAt = Date.now() + this.flushIntervalMs;
      return true;
    } catch (error) {
      if (error instanceof TelegramApiError && error.retryAfterSeconds !== null) {
        this.applyRateLimit('draft', error.retryAfterSeconds);
        return false;
      }

      console.error('sendMessageDraft failed', error);
      return false;
    }
  }

  private async sendTypingSafe(): Promise<void> {
    const now = Date.now();
    if (!this.typingHeartbeatEnabled || now < this.nextActionAllowedAt || now < this.nextTelegramAllowedAt) {
      return;
    }

    try {
      await this.telegram.sendChatAction({
        chatId: this.options.chatId,
        messageThreadId: this.options.messageThreadId,
        action: this.options.actionText ?? 'typing',
      });
      this.nextActionAllowedAt = Date.now() + this.actionIntervalMs;
    } catch (error) {
      if (error instanceof TelegramApiError && error.retryAfterSeconds !== null) {
        this.applyRateLimit('action', error.retryAfterSeconds);
        return;
      }

      console.error('sendChatAction failed', error);
    }
  }

  private async ensureTemporaryStatusMessage(): Promise<void> {
    if (this.temporaryStatusMessageId !== null) {
      return;
    }

    try {
      const preview = createTelegramMarkdownPreview(this.statusText);
      const sent = await sendTelegramMarkdownMessage(this.telegram, {
        chatId: this.options.chatId,
        messageThreadId: this.options.messageThreadId,
        text: preview.rawText,
      });
      this.temporaryStatusMessageId = sent.message_id;
      this.lastTemporaryStatusText = preview.text;
      this.temporaryStatusRevision += 1;
      this.typingHeartbeatEnabled = false;
      this.stopTypingHeartbeat();
      console.log(`[draft] created temporary status message ${sent.message_id}`);
    } catch (error) {
      console.error('send temporary status message failed', error);
    }
  }

  private async updateTemporaryStatusMessage(preview: ReturnType<typeof createTelegramMarkdownPreview>): Promise<boolean> {
    if (this.temporaryStatusMessageId === null || preview.text === this.lastTemporaryStatusText) {
      return false;
    }

    if (Date.now() < this.nextStatusAllowedAt) {
      return false;
    }

    const messageId = this.temporaryStatusMessageId;
    const revision = this.temporaryStatusRevision;

    try {
      await editTelegramMarkdownMessage(this.telegram, {
        chatId: this.options.chatId,
        messageId,
        text: preview.rawText,
      });
      if (this.temporaryStatusMessageId === messageId && this.temporaryStatusRevision === revision) {
        this.lastTemporaryStatusText = preview.text;
      }
      this.nextStatusAllowedAt = Date.now() + this.placeholderIntervalMs;
      return true;
    } catch (error) {
      if (isMessageNotFoundError(error)) {
        if (this.temporaryStatusMessageId === messageId && this.temporaryStatusRevision === revision) {
          this.temporaryStatusMessageId = null;
          this.lastTemporaryStatusText = '';
          this.temporaryStatusRevision += 1;
        }
        this.typingHeartbeatEnabled = true;
        this.startTypingHeartbeat();
        return false;
      }

      if (error instanceof TelegramApiError && error.retryAfterSeconds !== null) {
        this.applyRateLimit('status', error.retryAfterSeconds);
        return false;
      }

      console.error('edit temporary status message failed', error);
      return false;
    }
  }

  private async deleteTemporaryStatusMessage(): Promise<void> {
    if (this.temporaryStatusMessageId === null) {
      return;
    }

    const messageId = this.temporaryStatusMessageId;
    const revision = this.temporaryStatusRevision;

    try {
      await this.telegram.deleteMessage({
        chatId: this.options.chatId,
        messageId,
      });
      console.log(`[draft] deleted temporary status message ${messageId}`);
    } catch (error) {
      if (!isMessageNotFoundError(error)) {
        console.error('delete temporary status message failed', error);
      }
    } finally {
      if (this.temporaryStatusMessageId === messageId && this.temporaryStatusRevision === revision) {
        this.temporaryStatusMessageId = null;
        this.lastTemporaryStatusText = '';
        this.temporaryStatusRevision += 1;
      }
    }
  }

  private hasPendingAnswer(): boolean {
    return this.answerText.length > 0 && this.answerText !== this.lastSentAnswerText;
  }

  private hasPendingStatus(): boolean {
    return this.statusText.length > 0 && this.statusText !== this.lastSentStatusText;
  }

  private getNextFlushDelay(): number {
    const now = Date.now();
    let nextAllowedAt = now + this.flushIntervalMs;

    if (this.hasPendingAnswer()) {
      nextAllowedAt = Math.max(nextAllowedAt, this.nextDraftAllowedAt, this.nextTelegramAllowedAt);
    }

    if (this.hasPendingStatus()) {
      nextAllowedAt = Math.max(nextAllowedAt, this.nextStatusAllowedAt, this.nextTelegramAllowedAt);
    }

    return Math.max(0, nextAllowedAt - now);
  }

  private applyRateLimit(kind: 'draft' | 'status' | 'action', retryAfterSeconds: number): void {
    const retryAt = Date.now() + retryAfterSeconds * 1000;

    this.nextTelegramAllowedAt = Math.max(this.nextTelegramAllowedAt, retryAt);

    if (kind === 'draft') {
      this.nextDraftAllowedAt = Math.max(this.nextDraftAllowedAt, retryAt);
    } else if (kind === 'status') {
      this.nextStatusAllowedAt = Math.max(this.nextStatusAllowedAt, retryAt);
    } else {
      this.nextActionAllowedAt = Math.max(this.nextActionAllowedAt, retryAt);
    }

    this.logRateLimit(kind, retryAfterSeconds);
  }

  private logRateLimit(kind: 'draft' | 'status' | 'action', retryAfterSeconds: number): void {
    const now = Date.now();
    const lastLoggedAt =
      kind === 'draft'
        ? this.lastDraftRateLimitLogAt
        : kind === 'status'
          ? this.lastStatusRateLimitLogAt
          : this.lastActionRateLimitLogAt;

    if (now - lastLoggedAt < 5000) {
      return;
    }

    if (kind === 'draft') {
      this.lastDraftRateLimitLogAt = now;
    } else if (kind === 'status') {
      this.lastStatusRateLimitLogAt = now;
    } else {
      this.lastActionRateLimitLogAt = now;
    }

    console.warn(`[draft] ${kind} updates rate-limited by Telegram; backing off for ${retryAfterSeconds}s`);
  }
}

function isMessageNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('message to edit not found') || error.message.includes('message to delete not found'))
  );
}
