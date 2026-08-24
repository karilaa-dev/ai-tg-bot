import type { MessageKind } from "../db/types.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback, threadExtra } from "./replies.js";
import type { TelegramTurnSource } from "../db/repos/turnRuns.js";
import type { DurableTurnAttachment } from "../db/repos/turnRuns.js";

export async function handleUserText(
  ctx: BotContext,
  text: string,
  options: {
    userMessageKind?: MessageKind;
    userMessageContent?: unknown;
    attachments?: DurableTurnAttachment[];
    sources?: TelegramTurnSource[];
  } = {},
): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  const startedAt = Date.now();
  const kind = options.userMessageKind ?? "text";
  const content = options.userMessageContent ?? { text };
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
    kind,
    content,
    textPlain: text,
    sources: options.sources ?? [telegramTurnSource(ctx, { kind, content, textPlain: text })],
    attachments: options.attachments,
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

export function telegramTurnSource(
  ctx: BotContext,
  payload?: TelegramTurnSource["payload"],
): TelegramTurnSource {
  return {
    updateId: ctx.update.update_id,
    messageId: ctx.message?.message_id ?? null,
    payload,
  };
}
