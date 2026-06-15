import { GrammyError } from "grammy";
import { isRichParseError, isThreadNotFound, sendRichDraft, type InputRichMessage, type RawRichApi } from "./richApi.js";
import { renderDraft, type RenderT, variantsForRichRetry } from "./render.js";

type DraftFrame = { thinkingMd: string; answerMd: string };
type PendingDraft = { frame: DraftFrame; force: boolean };
type DraftSendResult = "sent" | "dropped" | { retryAfterMs: number };

const floodWaitSafetyMs = 100;

export interface DraftStreamerOptions {
  api: RawRichApi;
  chatId: number;
  messageThreadId?: number;
  threadTitle?: string;
  updateMs: number;
  t: RenderT;
}

export class DraftStreamer {
  private readonly draftId = (Date.now() & 0x7fffffff) || 1;
  private lastSentAt = 0;
  private lastHash = "";
  private latest?: DraftFrame;
  private pending?: PendingDraft;
  private timer?: NodeJS.Timeout;
  private timerAt = 0;
  private keepalive?: NodeJS.Timeout;
  private sending = false;
  private blockedUntil = 0;
  private threadUnavailable = false;
  private closed = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: DraftStreamerOptions) {}

  update(frame: DraftFrame): void {
    this.queue(frame, false);
  }

  startKeepalive(): void {
    this.keepalive ??= setInterval(() => {
      if (this.latest) this.queue(this.latest, true);
    }, 20_000);
  }

  stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.stopKeepalive();
    this.timer = undefined;
    this.timerAt = 0;
    this.pending = undefined;
    this.closed = true;
    this.resolveIdle();
  }

  async finish(frame?: DraftFrame): Promise<void> {
    this.stopKeepalive();
    if (frame && (frame.thinkingMd.trim() || frame.answerMd.trim())) this.queue(frame, false);
    else this.schedulePump();
    await this.waitForIdle();
  }

  private queue(frame: DraftFrame, force: boolean): void {
    if (this.closed) return;
    this.latest = frame;
    this.pending = { frame, force };
    this.schedulePump();
  }

  private renderPending(frame: DraftFrame): InputRichMessage {
    return renderDraft({ ...frame, t: this.options.t });
  }

  private schedulePump(): void {
    if (this.closed) return;
    if (this.sending) return;
    if (!this.pending) {
      this.resolveIdle();
      return;
    }
    const readyAt = Math.max(this.lastSentAt + Math.max(0, this.options.updateMs), this.blockedUntil);
    const delay = Math.max(0, readyAt - Date.now());
    if (delay === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.timerAt = 0;
      void this.pump();
      return;
    }
    if (this.timer && this.timerAt <= readyAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = readyAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = 0;
      void this.pump();
    }, delay);
  }

  private async pump(): Promise<void> {
    if (this.closed || this.sending) return;
    const queued = this.pending;
    if (!queued) {
      this.resolveIdle();
      return;
    }
    const readyAt = Math.max(this.lastSentAt + Math.max(0, this.options.updateMs), this.blockedUntil);
    if (Date.now() < readyAt) {
      this.schedulePump();
      return;
    }
    this.pending = undefined;
    const payload = this.renderPending(queued.frame);
    const hash = JSON.stringify(payload);
    if (!queued.force && hash === this.lastHash) {
      this.schedulePump();
      return;
    }
    this.sending = true;
    const result = await this.send(payload);
    this.sending = false;
    if (this.closed) {
      this.resolveIdle();
      return;
    }
    if (typeof result === "object") {
      if (!this.pending) this.pending = queued;
      this.blockedUntil = Date.now() + result.retryAfterMs;
    } else {
      this.lastHash = hash;
      this.lastSentAt = Date.now();
    }
    this.schedulePump();
  }

  private waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private isIdle(): boolean {
    return this.closed || (!this.pending && !this.sending && !this.timer);
  }

  private async send(payload: InputRichMessage): Promise<DraftSendResult> {
    try {
      await this.sendDraft(payload);
      return "sent";
    } catch (err) {
      const waitMs = retryAfterMs(err);
      if (waitMs !== undefined) return { retryAfterMs: waitMs };
      if (this.options.messageThreadId && isThreadNotFound(err)) {
        this.threadUnavailable = true;
        try {
          await this.sendDraft(payload);
          return "sent";
        } catch (retryErr) {
          const retryWaitMs = retryAfterMs(retryErr);
          if (retryWaitMs !== undefined) return { retryAfterMs: retryWaitMs };
          // Drafts are previews; the next frame or final message supersedes dropped frames.
          return "dropped";
        }
      }
      if (!isRichParseError(err) || !("markdown" in payload)) return "dropped";
      const retry = variantsForRichRetry(payload.markdown ?? "")[1];
      if (retry) {
        try {
          await this.sendDraft(retry);
          return "sent";
        } catch (retryErr) {
          const retryWaitMs = retryAfterMs(retryErr);
          if (retryWaitMs !== undefined) return { retryAfterMs: retryWaitMs };
        }
      }
      return "dropped";
    }
  }

  private sendDraft(payload: InputRichMessage): Promise<boolean> {
    return sendRichDraft(this.options.api, {
      chat_id: this.options.chatId,
      message_thread_id: this.threadUnavailable ? undefined : this.options.messageThreadId,
      draft_id: this.draftId,
      rich_message: this.threadUnavailable ? this.prefixForThreadFallback(payload) : payload,
    });
  }

  private prefixForThreadFallback(payload: InputRichMessage): InputRichMessage {
    const title = this.options.threadTitle?.trim();
    if (!title) return payload;
    if (payload.markdown !== undefined) return { ...payload, markdown: `**${escapeMarkdownTitle(title)}**\n\n${payload.markdown}` };
    return { ...payload, html: `<p><strong>${escapeHtml(title)}</strong></p>\n\n${payload.html ?? ""}` };
  }
}

function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof GrammyError) || err.error_code !== 429) return undefined;
  const retryAfter = err.parameters.retry_after;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return floodWaitSafetyMs;
  return retryAfter * 1000 + floodWaitSafetyMs;
}

function escapeMarkdownTitle(title: string): string {
  return title.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
