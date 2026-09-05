import type { NextFunction } from "grammy";
import type { ThreadTitleSource } from "../db/types.js";
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
  if (ctx.from?.is_bot && ctx.msg?.forum_topic_edited) {
    // Our service messages must not create a user/thread owned by the bot or
    // promote its temporary activity marker to a permanent topic title.
    await next();
    return;
  }
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
    const created = ctx.msg?.forum_topic_created;
    const isGeneral = topicId === null || topicId === 1;
    const title = isGeneral ? "General" : created?.name?.trim() || `Topic ${topicId}`;
    const titleSource: ThreadTitleSource = isGeneral
      ? "explicit"
      : created && !created.is_name_implicit
        ? "explicit"
        : "placeholder";
    ctx.thread = await ctx.services.repos.threads.activeForUserTopic(user.tg_id, topicId, title, titleSource);

    const editedTitle = ctx.msg?.forum_topic_edited?.name?.trim();
    const observedTitle = created?.name?.trim();
    const activityEcho = topicId !== null && editedTitle
      && (await ctx.services.threadTitles.isRequestedActivityTitle(ctx.chat.id, topicId, editedTitle)
        || editedTitle === `⏳ ${Array.from(ctx.thread.title).slice(0, 126).join("")}`);
    if (!activityEcho && topicId !== null && (editedTitle || observedTitle)) {
      await ctx.services.threadTitles.observeTelegramTitle(ctx.chat.id, topicId, (editedTitle || observedTitle)!);
    }
    if (editedTitle && !activityEcho && editedTitle !== ctx.thread.title) {
      ctx.thread = await ctx.services.repos.threads.applyTelegramTopicTitle(ctx.thread.id, editedTitle, false) ?? ctx.thread;
      void ctx.services.threadTitles.syncActivity({ api: ctx.api, chatId: ctx.chat.id, threadId: ctx.thread.id });
    } else if (observedTitle) {
      ctx.thread = await ctx.services.repos.threads.applyTelegramTopicTitle(
        ctx.thread.id,
        observedTitle,
        Boolean(created?.is_name_implicit),
      ) ?? ctx.thread;
    }
    ctx.services.logger.debug("thread resolved for update", ctxLogMeta(ctx, {
      topicId,
      activeThreadId: ctx.thread.id,
      titleSource: ctx.thread.title_source,
    }));
  }
  await next();
}
