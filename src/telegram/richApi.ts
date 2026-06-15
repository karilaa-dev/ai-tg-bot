import { GrammyError } from "grammy";
import type { Message } from "grammy/types";

export interface RawRichApi {
  raw: Record<string, (...args: any[]) => Promise<any>>;
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
  if (result === true) {
    return {
      message_id: 0,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(params.chat_id), type: "private", first_name: "test" },
    } as Message;
  }
  return result as Message;
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

export function isRichParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    !isThreadNotFound(err) &&
    /parse|entity|rich|markdown|html|can't parse|bad request/i.test(err.description)
  );
}
