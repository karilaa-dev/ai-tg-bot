import type { NextFunction } from "grammy";
import type { Locale } from "../db/types.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback } from "./replies.js";

export function isStopCommand(ctx: BotContext): boolean {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  return /^\/stop(?:@\w+)?(?:\s|$)/.test(text ?? "");
}

export function isAdmin(ctx: BotContext): boolean {
  return ctx.from?.id === ctx.services.config.TELEGRAM_ADMIN_ID;
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

export async function authAndThread(ctx: BotContext, next: NextFunction): Promise<void> {
  if (!ctx.from) {
    ctx.services.logger.debug("update has no sender; skipping auth", ctxLogMeta(ctx));
    await next();
    return;
  }
  const lang = ctx.from.language_code?.startsWith("ru") ? "ru" : "en";
  let user = await ctx.services.repos.users.get(ctx.from.id);
  if (!user && ctx.from.id === ctx.services.config.TELEGRAM_ADMIN_ID) {
    user = await ctx.services.repos.users.ensure({
      tgId: ctx.from.id,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
      lang,
    });
    ctx.services.logger.info("admin user created", ctxLogMeta(ctx, { lang }));
  }
  if (!user) {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
    const code = text?.startsWith("/start ") ? text.slice(7).trim() : ctx.services.routerState.awaitingCode.has(ctx.from.id) ? text?.trim() : undefined;
    if (code) {
      ctx.services.logger.debug("invite code submitted", ctxLogMeta(ctx));
      const ok = await redeemInvite(ctx, code, lang);
      if (ok) {
        user = await ctx.services.repos.users.get(ctx.from.id);
      } else {
        return;
      }
    } else if (text) {
      // any text (including bare /start) prompts for an invite code
      ctx.services.routerState.awaitingCode.add(ctx.from.id);
      ctx.services.logger.info("unknown user asked for invite code", ctxLogMeta(ctx, { lang }));
      await replyWithThreadFallback(ctx, ctx.t("invite-ask"));
      return;
    } else {
      ctx.services.logger.debug("unauthorized non-text update ignored", ctxLogMeta(ctx));
      return;
    }
  }
  if (!user) return;
  const knownUser = user;
  ctx.user = knownUser;
  if (ctx.chat) {
    const topicId = ctx.msg?.message_thread_id ?? null;
    ctx.thread = await ctx.services.repos.threads.activeForUserTopic(knownUser.tg_id, topicId, topicId ? `Topic ${topicId}` : "General");
    ctx.services.logger.debug("thread resolved for update", ctxLogMeta(ctx, {
      topicId,
      activeThreadId: ctx.thread.id,
    }));
  }
  await next();
}

async function redeemInvite(ctx: BotContext, code: string, lang: Locale): Promise<boolean> {
  const result = await ctx.services.repos.invites.validate(code);
  if (!result.ok) {
    ctx.services.logger.warn("invite redemption rejected", ctxLogMeta(ctx, { reason: result.reason }));
    await replyWithThreadFallback(ctx, ctx.t(`invite-invalid-${result.reason}`));
    ctx.services.routerState.awaitingCode.add(ctx.from!.id);
    return false;
  }
  await ctx.services.repos.users.ensure({
    tgId: ctx.from!.id,
    firstName: ctx.from!.first_name,
    username: ctx.from!.username,
    lang,
    invitedWith: code,
  });
  await ctx.services.repos.invites.consume(code);
  ctx.services.routerState.awaitingCode.delete(ctx.from!.id);
  ctx.services.logger.info("invite redeemed", ctxLogMeta(ctx, { lang }));
  return true;
}
