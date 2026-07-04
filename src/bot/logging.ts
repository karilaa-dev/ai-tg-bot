import type { Logger } from "../logger.js";
import type { BotContext } from "./context.js";

export function messageThreadId(ctx: BotContext): number | null {
  return ctx.msg?.message_thread_id ?? null;
}

export function ctxLogMeta(ctx: BotContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    updateId: ctx.update.update_id,
    userId: ctx.from?.id ?? null,
    chatId: ctx.chat?.id ?? null,
    threadId: ctx.thread?.id ?? null,
    topicId: ctx.thread?.topic_id ?? messageThreadId(ctx),
    ...extra,
  };
}

export function logCommand(ctx: BotContext, command: string): void {
  ctx.services.logger.info("bot command received", ctxLogMeta(ctx, { command }));
}

export function logCallback(ctx: BotContext, action: string, extra: Record<string, unknown> = {}): void {
  ctx.services.logger.debug("callback received", ctxLogMeta(ctx, { action, ...extra }));
}

export function optionalLogger(ctx: BotContext): Logger | undefined {
  return (ctx as Partial<BotContext>).services?.logger;
}
