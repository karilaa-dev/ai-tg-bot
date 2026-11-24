import { GrammyError } from "grammy";
import type { MessageGenerationStopped } from "grammy/types";
import { isRichParseError, isThreadNotFound, prefixRichForThreadFallback, sendRichDraft, type InputRichMessage, type RawRichApi } from "./richApi.js";
import { renderAnswerDraft, renderDraft, type RenderT, variantsForRichRetry } from "./render.js";

type DraftFrame = { thinkingMd: string; answerMd: string };
type PendingDraft = { frame: DraftFrame; force: boolean; elapsedMs: number };
type DraftPump =
  | { phase: "idle" }
  | { phase: "waiting"; timer: NodeJS.Timeout; readyAt: number }
  | { phase: "sending" };
type DraftSendResult = "sent" | "dropped" | { retryAfterMs: number };

const floodWaitSafetyMs = 100;
const thinkingElapsedTickMs = 10_000;
const maxDraftId = 0x7fffffff;
let lastDraftId = (Date.now() & maxDraftId) || 1;
const activeDrafts = new WeakMap<RawRichApi, Map<string, DraftStreamer>>();

function allocateDraftId(): number {
  lastDraftId = lastDraftId >= maxDraftId ? 1 : lastDraftId + 1;
  return lastDraftId;
}

interface DraftStreamerOptions {
  api: RawRichApi;
  chatId: number;
  messageThreadId?: number;
  threadTitle?: string;
  startedAt: number;
  updateMs: number;
  t: RenderT;
  answerOnly?: boolean;
  onStop?: () => Promise<boolean>;
}

export class DraftStreamer {
  private readonly draftId = allocateDraftId();
  private readonly controller = new AbortController();
  private lastSentAt = 0;
  private lastHash = "";
  private latest?: DraftFrame;
  private pending?: PendingDraft;
  private pumpState: DraftPump = { phase: "idle" };
  private elapsedTimer?: NodeJS.Timeout;
  private lastThinkingMd: string | undefined;
  private titleElapsedMs = 0;
  private blockedUntil = 0;
  private threadUnavailable = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: DraftStreamerOptions) {}

  static async stopGeneration(api: RawRichApi, stopped: MessageGenerationStopped): Promise<boolean> {
    // Telegram may encode the identifier as a string even though grammY types
    // it as a number. Use the same key for both wire representations.
    const streamer = activeDrafts.get(api)?.get(String(stopped.draft_id));
    if (!streamer || stopped.chat.type !== "private" || stopped.chat.id !== streamer.options.chatId) return false;
    const topicId = streamer.threadUnavailable ? undefined : streamer.options.messageThreadId;
    if ((stopped.message_thread_id ?? 1) !== (topicId ?? 1)) return false;
    streamer.stop();
    return await streamer.options.onStop?.() ?? false;
  }

  update(frame: DraftFrame): void {
    const thinkingChanged = this.trackThinking(frame);
    this.queue(frame, false, this.titleElapsedMs);
    if (thinkingChanged) this.scheduleElapsedTick();
  }

  private trackThinking(frame: DraftFrame): boolean {
    if (frame.thinkingMd === this.lastThinkingMd) return false;
    this.lastThinkingMd = frame.thinkingMd;
    this.titleElapsedMs = this.elapsedMs();
    return true;
  }

  stop(): void {
    this.stopUpdates();
    activeDrafts.get(this.options.api)?.delete(String(this.draftId));
  }

  stopUpdates(): void {
    this.clearPumpTimer();
    this.stopElapsedTick();
    this.pending = undefined;
    this.controller.abort();
    this.resolveIdle();
  }

  async finish(frame?: DraftFrame): Promise<void> {
    this.stopElapsedTick();
    if (frame && (frame.thinkingMd.trim() || frame.answerMd.trim())) {
      this.trackThinking(frame);
      this.queue(frame, false, this.titleElapsedMs);
    } else {
      this.schedulePump();
    }
    await this.waitForIdle();
  }

  private queue(frame: DraftFrame, force: boolean, elapsedMs: number): void {
    if (this.controller.signal.aborted) return;
    this.latest = frame;
    this.pending = { frame, force, elapsedMs };
    this.schedulePump();
  }

  private renderPending(pending: PendingDraft): InputRichMessage {
    if (this.options.answerOnly) return renderAnswerDraft(pending.frame.answerMd);
    return renderDraft({ ...pending.frame, elapsedMs: pending.elapsedMs, t: this.options.t });
  }

  private elapsedMs(): number {
    return Math.max(0, Date.now() - this.options.startedAt);
  }

  private scheduleElapsedTick(): void {
    if (this.controller.signal.aborted || !this.latest) return;
    this.stopElapsedTick();
    this.elapsedTimer = setTimeout(() => {
      this.elapsedTimer = undefined;
      if (!this.latest || this.controller.signal.aborted) return;
      this.titleElapsedMs = this.elapsedMs();
      this.queue(this.latest, true, this.titleElapsedMs);
      this.scheduleElapsedTick();
    }, thinkingElapsedTickMs);
  }

  private stopElapsedTick(): void {
    if (this.elapsedTimer) clearTimeout(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }

  private nextReadyAt(): number {
    return Math.max(this.lastSentAt + Math.max(0, this.options.updateMs), this.blockedUntil);
  }

  private clearPumpTimer(): void {
    if (this.pumpState.phase !== "waiting") return;
    clearTimeout(this.pumpState.timer);
    this.pumpState = { phase: "idle" };
  }

  private schedulePump(): void {
    if (this.controller.signal.aborted) return;
    if (this.pumpState.phase === "sending") return;
    if (!this.pending) {
      this.resolveIdle();
      return;
    }
    const readyAt = this.nextReadyAt();
    const delay = Math.max(0, readyAt - Date.now());
    if (delay === 0) {
      this.clearPumpTimer();
      void this.pump();
      return;
    }
    if (this.pumpState.phase === "waiting" && this.pumpState.readyAt <= readyAt) return;
    this.clearPumpTimer();
    const timer = setTimeout(() => {
      this.pumpState = { phase: "idle" };
      void this.pump();
    }, delay);
    this.pumpState = { phase: "waiting", readyAt, timer };
  }

  private async pump(): Promise<void> {
    if (this.controller.signal.aborted || this.pumpState.phase === "sending") return;
    const queued = this.pending;
    if (!queued) {
      this.resolveIdle();
      return;
    }
    const readyAt = this.nextReadyAt();
    if (Date.now() < readyAt) {
      this.schedulePump();
      return;
    }
    this.pending = undefined;
    const payload = this.renderPending(queued);
    const hash = JSON.stringify(payload);
    if (!queued.force && hash === this.lastHash) {
      this.schedulePump();
      return;
    }
    this.pumpState = { phase: "sending" };
    const result = await this.send(payload);
    this.pumpState = { phase: "idle" };
    if (this.controller.signal.aborted) {
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
    return this.controller.signal.aborted || (!this.pending && this.pumpState.phase === "idle");
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
    if (this.controller.signal.aborted) return Promise.resolve(false);
    if (this.options.onStop) {
      let drafts = activeDrafts.get(this.options.api);
      if (!drafts) activeDrafts.set(this.options.api, drafts = new Map());
      drafts.set(String(this.draftId), this);
    }
    return sendRichDraft(this.options.api, {
      chat_id: this.options.chatId,
      message_thread_id: this.threadUnavailable ? undefined : this.options.messageThreadId,
      draft_id: this.draftId,
      rich_message: this.threadUnavailable ? this.prefixForThreadFallback(payload) : payload,
      can_stop: Boolean(this.options.onStop),
    }, this.controller.signal);
  }

  private prefixForThreadFallback(payload: InputRichMessage): InputRichMessage {
    const title = this.options.threadTitle?.trim();
    if (!title) return payload;
    return prefixRichForThreadFallback(title, payload);
  }
}

function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof GrammyError) || err.error_code !== 429) return undefined;
  const retryAfter = err.parameters.retry_after;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return floodWaitSafetyMs;
  return retryAfter * 1000 + floodWaitSafetyMs;
}
