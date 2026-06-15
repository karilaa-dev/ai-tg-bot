import { isRichParseError, isThreadNotFound, sendRichDraft, type InputRichMessage, type RawRichApi } from "./richApi.js";
import { renderDraft, type RenderT, variantsForRichRetry } from "./render.js";

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
  private pending?: { thinkingMd: string; answerMd: string };
  private timer?: NodeJS.Timeout;
  private keepalive?: NodeJS.Timeout;
  private threadUnavailable = false;

  constructor(private readonly options: DraftStreamerOptions) {}

  update(frame: { thinkingMd: string; answerMd: string }): void {
    this.pending = frame;
    const elapsed = Date.now() - this.lastSentAt;
    if (elapsed >= this.options.updateMs) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.updateMs - elapsed);
    }
  }

  startKeepalive(): void {
    this.keepalive ??= setInterval(() => {
      if (this.pending) void this.send(this.renderPending(this.pending), true);
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
  }

  private async flush(): Promise<void> {
    if (!this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const payload = this.renderPending(this.pending);
    await this.send(payload);
  }

  private renderPending(frame: { thinkingMd: string; answerMd: string }): InputRichMessage {
    return renderDraft({ ...frame, t: this.options.t });
  }

  private async send(payload: InputRichMessage, force = false): Promise<void> {
    const hash = JSON.stringify(payload);
    if (!force && hash === this.lastHash) return;
    this.lastHash = hash;
    this.lastSentAt = Date.now();
    try {
      await this.sendDraft(payload);
    } catch (err) {
      if (this.options.messageThreadId && isThreadNotFound(err)) {
        this.threadUnavailable = true;
        try {
          await this.sendDraft(payload);
        } catch {
          // Drafts are previews; the next frame or final message supersedes this.
        }
        return;
      }
      if (!isRichParseError(err) || !("markdown" in payload)) return;
      const retry = variantsForRichRetry(payload.markdown ?? "")[1];
      if (retry) {
        try {
          await this.sendDraft(retry);
        } catch {
          // Drafts are previews; the next frame or final message supersedes this.
        }
      }
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

function escapeMarkdownTitle(title: string): string {
  return title.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
