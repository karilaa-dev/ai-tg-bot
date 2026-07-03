import type { ThreadRow } from "../db/types.js";
import { isRichParseError, isThreadNotFound, prefixPlainForThreadFallback, sendRich, withThreadNotFoundFallback } from "../telegram/richApi.js";
import type { BotContext } from "./context.js";

export type ReplyOptions = Parameters<BotContext["reply"]>[1];

export async function replyRichMarkdownWithThreadFallback(
  ctx: BotContext,
  markdown: string,
  other?: ReplyOptions,
): Promise<void> {
  if (!ctx.chat) {
    await replyMarkdownWithThreadFallback(ctx, markdown, other);
    return;
  }
  const payload = (other ?? {}) as Record<string, unknown>;
  const messageThreadId = typeof payload.message_thread_id === "number" ? payload.message_thread_id : undefined;
  const replyMarkup = payload.reply_markup;
  try {
    await sendRich(ctx.api, {
      chat_id: ctx.chat.id,
      message_thread_id: messageThreadId,
      rich_message: { markdown },
      reply_markup: replyMarkup,
    });
    return;
  } catch (err) {
    if (!messageThreadId || !ctx.thread || !isThreadNotFound(err)) {
      if (!isRichParseError(err)) throw err;
      ctx.services.logger.warn("rich markdown reply failed; retrying as legacy markdown", {
        err: String(err),
      });
      await replyMarkdownWithThreadFallback(ctx, markdown, other);
      return;
    }
  }

  ctx.services.logger.warn("telegram topic rich reply failed; retrying without message_thread_id", {
    threadId: ctx.thread.id,
    topicId: messageThreadId,
  });
  try {
    await sendRich(ctx.api, {
      chat_id: ctx.chat.id,
      rich_message: { markdown: prefixPlainForThreadFallback(ctx.thread.title, markdown) },
      reply_markup: replyMarkup,
    });
  } catch (err) {
    if (!isRichParseError(err)) throw err;
    ctx.services.logger.warn("topic fallback rich markdown failed; retrying as legacy markdown", {
      err: String(err),
    });
    await replyMarkdownWithThreadFallback(ctx, markdown, other);
  }
}

export async function replyMarkdownWithThreadFallback(
  ctx: BotContext,
  text: string,
  other?: ReplyOptions,
): ReturnType<BotContext["reply"]> {
  try {
    return await replyWithThreadFallback(ctx, text, {
      ...other,
      parse_mode: "Markdown",
    });
  } catch (err) {
    ctx.services.logger.warn("markdown reply failed; retrying as plain text", {
      err: String(err),
    });
    return replyWithThreadFallback(ctx, text, other);
  }
}

export async function replyWithThreadFallback(
  ctx: BotContext,
  text: string,
  other?: ReplyOptions,
): ReturnType<BotContext["reply"]> {
  const payload = (other ?? {}) as Record<string, unknown>;
  return replyWithTitleThreadFallback(ctx, text, other, ctx.thread?.title, () => {
    ctx.services.logger.warn("telegram topic reply failed; retrying without message_thread_id", {
      threadId: ctx.thread!.id,
      topicId: payload.message_thread_id,
    });
  });
}

export async function replyWithTitleThreadFallback(
  ctx: BotContext,
  text: string,
  other: ReplyOptions | undefined,
  title: string | undefined,
  onFallback?: () => void,
): ReturnType<BotContext["reply"]> {
  const payload = (other ?? {}) as Record<string, unknown>;
  const messageThreadId = title && typeof payload.message_thread_id === "number" ? payload.message_thread_id : undefined;
  return withThreadNotFoundFallback(
    { messageThreadId, onFallback },
    () => ctx.reply(text, other),
    () => {
      const { message_thread_id: _messageThreadId, ...withoutThread } = payload;
      return ctx.reply(prefixPlainForThreadFallback(title!, text), withoutThread as ReplyOptions);
    },
  );
}

export async function clearInlineKeyboard(ctx: BotContext): Promise<void> {
  await ctx.editMessageReplyMarkup().catch((err) => {
    ctx.services.logger.debug("failed to clear inline keyboard", { err: String(err) });
  });
}

export async function editOrReply(ctx: BotContext, text: string, extra?: Parameters<BotContext["editMessageText"]>[1]): Promise<void> {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    await replyWithThreadFallback(ctx, text, { ...threadExtra(ctx.thread), ...extra });
  }
}

export function threadExtra(thread: ThreadRow | undefined) {
  return thread?.topic_id ? { message_thread_id: thread.topic_id } : {};
}
