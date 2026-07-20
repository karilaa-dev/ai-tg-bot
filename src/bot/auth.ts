import type { NextFunction } from "grammy";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback } from "./replies.js";

export function isStopCommand(ctx: BotContext): boolean {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  return /^\/stop(?:@\w+)?(?:\s|$)/.test(text ?? "");
}

export async function privateOnly(ctx: BotContext, next: NextFunction): Promise<void> {
  if (ctx.chat && ctx.chat.type !== "private") {
    ctx.services.logger.warn("non-private chat rejected", ctxLogMeta(ctx, { chatType: ctx.chat.type }));
    await replyWithThreadFallback(ctx, ctx.t("private-only")).catch(() => undefined);
    await ctx.leaveChat().catch(() => undefined);
    return;
  }
  await next();
}

export async function initializeUserAndThread(ctx: BotContext, next: NextFunction): Promise<void> {
  if (!ctx.from) {
    ctx.services.logger.debug("update has no sender; skipping user initialization", ctxLogMeta(ctx));
    await next();
    return;
  }
  const lang = ctx.from.language_code?.startsWith("ru") ? "ru" : "en";
  const user = await ctx.services.repos.users.ensure({
    tgId: ctx.from.id,
    firstName: ctx.from.first_name,
    username: ctx.from.username,
    lang,
  });
  ctx.user = user;
  if (ctx.chat) {
    const topicId = ctx.msg?.message_thread_id ?? null;
    ctx.thread = await ctx.services.repos.threads.activeForUserTopic(user.tg_id, topicId, topicId ? `Topic ${topicId}` : "General");
    ctx.services.logger.debug("thread resolved for update", ctxLogMeta(ctx, {
      topicId,
      activeThreadId: ctx.thread.id,
    }));
  }
  await next();
}
