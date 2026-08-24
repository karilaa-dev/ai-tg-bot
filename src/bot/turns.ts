import type { MessageKind, MessageRow } from "../db/types.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback, threadExtra } from "./replies.js";
import type { TelegramTurnSource } from "../db/repos/turnRuns.js";

export async function handleUserText(
  ctx: BotContext,
  text: string,
  options: {
    userMessageKind?: MessageKind;
    userMessageContent?: unknown;
    onUserMessagePersisted?: (message: MessageRow) => Promise<void>;
    sources?: TelegramTurnSource[];
  } = {},
): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  const startedAt = Date.now();
  ctx.services.logger.info("turn durable acceptance starting", ctxLogMeta(ctx, {
    kind: options.userMessageKind ?? "text",
    textChars: text.length,
  }));
  const accepted = await ctx.services.turnCoordinator.accept({
    userId: ctx.user.tg_id,
    threadId: ctx.thread.id,
    chatId: ctx.chat.id,
    messageThreadId: ctx.thread.topic_id,
    locale: ctx.user.lang,
    kind: options.userMessageKind ?? "text",
    content: options.userMessageContent ?? { text },
    textPlain: text,
    sources: options.sources ?? [telegramTurnSource(ctx)],
    onUserMessagePersisted: options.onUserMessagePersisted,
  });
  if (accepted.created && accepted.queuedBehind) {
    await replyWithThreadFallback(ctx, ctx.t("busy"), threadExtra(ctx.thread));
  }
  ctx.services.logger.info("turn durable acceptance finished", ctxLogMeta(ctx, {
    turnRunId: accepted.turnRun.id,
    kind: options.userMessageKind ?? "text",
    duplicate: !accepted.created || undefined,
    queuedBehind: accepted.queuedBehind || undefined,
    ms: Date.now() - startedAt,
  }));
}

export function telegramTurnSource(ctx: BotContext): TelegramTurnSource {
  return {
    updateId: ctx.update.update_id,
    messageId: ctx.message?.message_id ?? null,
  };
}
