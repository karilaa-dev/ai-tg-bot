import type { Conversation } from "@grammyjs/conversations";
import { formatUtcOffset, offsetFromLocalTime } from "./timezone.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta, optionalLogger } from "./logging.js";
import { onboardingTimezoneKeyboard } from "./keyboards.js";
import {
  replyMarkdownWithThreadFallback,
  replyRichMarkdownWithThreadFallback,
  replyWithTitleThreadFallback,
  threadExtra,
  type ReplyOptions,
} from "./replies.js";
import { sleep } from "../util/text.js";

type BotConversation = Conversation<BotContext, BotContext>;

export async function sendWelcome(ctx: BotContext): Promise<void> {
  await replyRichMarkdownWithThreadFallback(ctx, ctx.t("start-welcome"), threadExtra(ctx.thread));
  if (!ctx.user || ctx.user.tz_offset_min !== null) return;
  await sleep(ctx.services.config.ONBOARDING_TIMEZONE_DELAY_MS);
  const user = await ctx.services.repos.users.get(ctx.user.tg_id);
  if (!user || user.tz_offset_min !== null) return;
  ctx.user = user;
  await replyMarkdownWithThreadFallback(ctx, ctx.t("tz-onboarding-prompt"), {
    ...threadExtra(ctx.thread),
    reply_markup: onboardingTimezoneKeyboard(ctx.t, user.lang === "ru"),
  });
}

export async function timezoneConversation(conversation: BotConversation, ctx: BotContext): Promise<void> {
  optionalLogger(ctx)?.debug("timezone conversation started", ctxLogMeta(ctx));
  await conversationReply(conversation, ctx, (ctx) => markdownReplyData(ctx, ctx.t("tz-ask")));
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const answer = await conversation.waitFor("message:text");
    const text = answer.message.text;
    const offset = offsetFromLocalTime(text);
    if (offset === null) {
      optionalLogger(answer)?.debug("timezone input rejected", ctxLogMeta(answer, { attempt: attempts + 1 }));
      await conversationReply(conversation, answer, (ctx) => markdownReplyData(ctx, ctx.t("tz-bad-format")));
      continue;
    }
    const data = await conversation.external(async (ctx) => {
      await ctx.services.repos.users.setTimezone(ctx.from!.id, offset);
      return markdownReplyData(ctx, ctx.t("tz-set", { offset: formatUtcOffset(offset), time: text }));
    });
    optionalLogger(answer)?.info("timezone set", ctxLogMeta(answer, { offset }));
    await replyWithCapturedThreadFallback(answer, data);
    const ready = await conversation.external((ctx) => markdownReplyData(ctx, ctx.t("onboarding-ready")));
    await replyWithCapturedThreadFallback(answer, ready);
    return;
  }
  optionalLogger(ctx)?.info("timezone conversation ended after invalid attempts", ctxLogMeta(ctx));
}

async function conversationReply(
  conversation: BotConversation,
  ctx: BotContext,
  build: (ctx: BotContext) => ConversationReplyData,
): Promise<void> {
  const data = await conversation.external(build);
  await replyWithCapturedThreadFallback(ctx, data);
}

interface ConversationReplyData {
  text: string;
  other?: ReplyOptions;
  threadTitle?: string;
}

function replyData(ctx: BotContext, text: string, other: ReplyOptions = threadExtra(ctx.thread)): ConversationReplyData {
  return { text, other, threadTitle: ctx.thread?.title };
}

function markdownReplyData(ctx: BotContext, text: string, other: ReplyOptions = threadExtra(ctx.thread)): ConversationReplyData {
  return replyData(ctx, text, {
    ...other,
    parse_mode: "Markdown",
  });
}

async function replyWithCapturedThreadFallback(ctx: BotContext, data: ConversationReplyData): Promise<void> {
  await replyWithTitleThreadFallback(ctx, data.text, data.other, data.threadTitle);
}
