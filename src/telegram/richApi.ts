import { GrammyError } from "grammy";
import type { Message } from "grammy/types";
import { escapeHtml, escapeMarkdownTitle } from "../util/text.js";

export interface RawRichApi {
  raw: Record<string, (...args: any[]) => Promise<unknown>>;
}

export type InputRichMessage =
  | { markdown: string; html?: never; is_rtl?: boolean; skip_entity_detection?: boolean }
  | { html: string; markdown?: never; is_rtl?: boolean; skip_entity_detection?: boolean };

export interface SendRichMessageParams {
  business_connection_id?: string;
  chat_id: number | string;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  rich_message: InputRichMessage;
  disable_notification?: boolean;
  protect_content?: boolean;
  message_effect_id?: string;
  suggested_post_parameters?: unknown;
  reply_parameters?: unknown;
  reply_markup?: unknown;
}

export interface SendRichMessageDraftParams {
  chat_id: number;
  message_thread_id?: number;
  draft_id: number;
  rich_message: InputRichMessage;
}

export async function sendRich(
  api: RawRichApi,
  params: SendRichMessageParams,
): Promise<Message> {
  const result = await api.raw.sendRichMessage(params);
  if (result === true) return placeholderMessageForBooleanResult(params.chat_id);
  // grammY 1.43 / @grammyjs/types lack Bot API 10.1 rich-message types (see PLAN.md),
  // so this is the single intentional trust boundary where the raw response is narrowed.
  return result as Message;
}

// @bonkers-agency/grammy-test's TelegramServer returns `true` for unhandled 10.1 methods.
// Callers must not treat message_id 0 as a real message (run.ts filters `id > 0`).
function placeholderMessageForBooleanResult(chatId: number | string): Message {
  return {
    message_id: 0,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(chatId), type: "private", first_name: "test" },
  } as Message;
}

export async function sendRichDraft(
  api: RawRichApi,
  params: SendRichMessageDraftParams,
): Promise<boolean> {
  return Boolean(await api.raw.sendRichMessageDraft(params));
}

export function isThreadNotFound(err: unknown): boolean {
  return err instanceof GrammyError && /message thread not found/i.test(err.description);
}

export async function withThreadNotFoundFallback<T>(
  opts: { messageThreadId: number | undefined; onFallback?: () => void },
  attempt: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!opts.messageThreadId || !isThreadNotFound(err)) throw err;
    opts.onFallback?.();
    return fallback();
  }
}

export function prefixPlainForThreadFallback(title: string, text: string, html = false): string {
  return `[${html ? escapeHtml(title) : title}]\n\n${text}`;
}

export function prefixRichForThreadFallback<T extends { markdown?: string; html?: string }>(title: string, rich: T): T {
  if (rich.markdown !== undefined) return { ...rich, markdown: `**${escapeMarkdownTitle(title)}**\n\n${rich.markdown}` };
  return { ...rich, html: `<p><strong>${escapeHtml(title)}</strong></p>\n\n${rich.html ?? ""}` };
}

export function isRichParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    !isThreadNotFound(err) &&
    /parse|entity|rich|markdown|html|can't parse|bad request/i.test(err.description)
  );
}
