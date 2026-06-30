import fs from "node:fs/promises";
import path from "node:path";
import { Bot, GrammyError, HttpError, type NextFunction } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { conversations, createConversation, type Conversation } from "@grammyjs/conversations";
import { sequentialize } from "@grammyjs/runner";
import { format } from "date-fns";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { createRepos, type Repos } from "../db/repos/index.js";
import type { FileRow, MessageRow, ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { compactThread, type ConversationSummarizer } from "../memory/compactor.js";
import type { ImageCaptioner } from "../ai/provider.js";
import { runTurn, type TurnRunner } from "../ai/run.js";
import { formatUtcOffset, offsetFromLocalTime } from "./timezone.js";
import type { BotContext, BotServices } from "./context.js";
import { localizedCommands } from "./commands.js";
import { languageKeyboard, onboardingTimezoneKeyboard } from "./keyboards.js";
import { Localizer } from "./i18n.js";
import { cardForFile, classifyFile, ingestFileBytes, type AcceptedFileType, type FileIngestProgress } from "../files/ingest.js";
import { sha256Hex } from "../files/hash.js";
import { downloadTelegramFile, type TelegramFileDownloader } from "../files/telegram.js";
import { isAbortError, throwIfAborted } from "../files/cancel.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import type { TextEmbedder } from "../memory/embeddings.js";
import { isRichParseError, isThreadNotFound, sendRich } from "../telegram/richApi.js";

interface InstallOptions {
  config: AppConfig;
  db: AppDatabase;
  logger: Logger;
  repos?: Repos;
  localizer?: Localizer;
  turnRunner?: TurnRunner;
  downloadFile?: TelegramFileDownloader;
  embedder?: TextEmbedder;
  imageCaptioner?: ImageCaptioner;
  summarizer?: ConversationSummarizer;
}

const awaitingCode = new Map<number, true>();
const busyThreads = new Set<number>();
const activeFileJobs = new Map<string, ActiveFileJob>();
const mediaGroupFlushMs = 250;
const textBurstFlushMs = 1_000;
const splitTextChunkMinChars = 3_000;
const inviteUseOptions = [1, 5, 10] as const;
const inviteExpiryOptions = ["7d", "30d", "never"] as const;
const moscowTimezoneOffsetMin = 180;
type InviteExpiry = typeof inviteExpiryOptions[number];
type BotConversation = Conversation<BotContext, BotContext>;

interface ActiveFileJob {
  controller: AbortController;
  status: FileProcessingStatus;
}

interface PendingMediaGroupItem {
  caption?: string;
  card: string;
  file: {
    id: number;
    type: "txt" | "csv" | "pdf" | "docx" | "image";
    name: string;
    inline: boolean;
  };
}

interface TelegramFileInput {
  fileId: string;
  fileUniqueId?: string | null;
  name: string;
  mime?: string;
  caption?: string;
  type: AcceptedFileType;
  size?: number;
  mediaGroupId?: string;
}

interface PreparedTelegramFile {
  fileId: number;
  card: string;
  inline: boolean;
  type: AcceptedFileType;
}

interface PendingMediaGroup {
  ctx: BotContext;
  timer: NodeJS.Timeout;
  items: PendingMediaGroupItem[];
}

interface PendingTextBurst {
  ctx: BotContext;
  timer: NodeJS.Timeout;
  texts: string[];
}

const pendingMediaGroups = new Map<string, PendingMediaGroup>();
const pendingTextBursts = new Map<string, PendingTextBurst>();

export function createBot(options: InstallOptions): Bot<BotContext> {
  const bot = new Bot<BotContext>(options.config.BOT_TOKEN);
  installBot(bot, options);
  return bot;
}

export function installBot(bot: Bot<BotContext>, options: InstallOptions): BotServices {
  options.logger.info("installing bot handlers", {
    hasCustomRepos: Boolean(options.repos),
    hasCustomLocalizer: Boolean(options.localizer),
    hasCustomTurnRunner: Boolean(options.turnRunner),
    hasEmbedder: Boolean(options.embedder),
    hasImageCaptioner: Boolean(options.imageCaptioner),
    hasSummarizer: Boolean(options.summarizer),
  });
  const repos = options.repos ?? createRepos(options.db.db, options.db.search);
  const localizer = options.localizer ?? new Localizer();
  const services: BotServices = {
    config: options.config,
    db: options.db,
    repos,
    logger: options.logger,
    turnRunner: options.turnRunner ?? runTurn,
    downloadFile: options.downloadFile ?? downloadTelegramFile,
    embedder: options.embedder,
    imageCaptioner: options.imageCaptioner,
    summarizer: options.summarizer,
  };

  bot.api.config.use(autoRetry());
  bot.use(async (ctx, next) => {
    ctx.services = services;
    ctx.t = (key, params) => localizer.t(ctx.user?.lang ?? ctx.from?.language_code, key, params);
    await next();
  });
  bot.use(sequentialize<BotContext>(threadSequentializationKey));
  bot.use(privateOnly);
  bot.use(authAndThread);
  bot.use(conversations<BotContext, BotContext>());
  bot.use(createConversation<BotContext, BotContext>(timezoneConversation, "timezone"));
  bot.use(async (ctx, next) => {
    if (!isPlainUserText(ctx)) {
      await flushPendingTextBurstForContext(ctx);
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    logCommand(ctx, "start");
    await sendWelcome(ctx);
  });
  bot.command("help", async (ctx) => {
    logCommand(ctx, "help");
    await replyWithThreadFallback(ctx, ctx.t("help"), threadExtra(ctx.thread));
  });
  bot.command("stop", async (ctx) => {
    logCommand(ctx, "stop");
    await stopActiveFileProcessing(ctx);
  });
  bot.command("lang", async (ctx) => {
    logCommand(ctx, "lang");
    await replyWithThreadFallback(ctx, ctx.t("lang-pick", { lang: ctx.user?.lang ?? "en" }), {
      ...threadExtra(ctx.thread),
      reply_markup: languageKeyboard(),
    });
  });
  bot.callbackQuery(/^lang:(en|ru)$/, async (ctx) => {
    const lang = ctx.match[1] as "en" | "ru";
    logCallback(ctx, "lang:set", { lang });
    if (ctx.user) {
      await ctx.services.repos.users.setLang(ctx.user.tg_id, lang);
      ctx.user = { ...ctx.user, lang };
    }
    if (ctx.chat) {
      await ctx.api.setMyCommands(localizedCommands(lang), { scope: { type: "chat", chat_id: ctx.chat.id } });
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ctx.t("lang-set")).catch(() => replyWithThreadFallback(ctx, ctx.t("lang-set"), threadExtra(ctx.thread)));
  });
  bot.command("stream", async (ctx) => {
    logCommand(ctx, "stream");
    if (!ctx.user) return;
    const updated = await ctx.services.repos.users.toggleStream(ctx.user.tg_id);
    ctx.user = updated;
    ctx.services.logger.info("stream mode toggled", ctxLogMeta(ctx, { enabled: updated.stream_mode }));
    await replyWithThreadFallback(ctx, ctx.t(updated.stream_mode ? "stream-on" : "stream-off"), threadExtra(ctx.thread));
  });
  bot.command("timezone", async (ctx) => {
    logCommand(ctx, "timezone");
    if (!ctx.from) return;
    await ctx.conversation.enter("timezone");
  });
  bot.callbackQuery("tz:onboarding:set", async (ctx) => {
    logCallback(ctx, "timezone:onboarding:set");
    await ctx.answerCallbackQuery();
    await clearInlineKeyboard(ctx);
    await ctx.conversation.enter("timezone");
  });
  bot.callbackQuery("tz:onboarding:later", async (ctx) => {
    logCallback(ctx, "timezone:onboarding:later");
    await ctx.answerCallbackQuery();
    await clearInlineKeyboard(ctx);
    await replyMarkdownWithThreadFallback(ctx, ctx.t("tz-onboarding-later"), threadExtra(ctx.thread));
  });
  bot.callbackQuery("tz:onboarding:moscow", async (ctx) => {
    logCallback(ctx, "timezone:onboarding:moscow");
    if (!ctx.user || !ctx.from) return;
    await ctx.services.repos.users.setTimezone(ctx.from.id, moscowTimezoneOffsetMin);
    ctx.user = { ...ctx.user, tz_offset_min: moscowTimezoneOffsetMin };
    await ctx.answerCallbackQuery();
    await clearInlineKeyboard(ctx);
    await replyMarkdownWithThreadFallback(ctx, ctx.t("tz-direct-set", {
      label: ctx.t("tz-moscow-label"),
      offset: formatUtcOffset(moscowTimezoneOffsetMin),
    }), threadExtra(ctx.thread));
    await replyMarkdownWithThreadFallback(ctx, ctx.t("onboarding-ready"), threadExtra(ctx.thread));
  });
  bot.command("compact", async (ctx) => {
    logCommand(ctx, "compact");
    if (!ctx.thread) return;
    const status = await replyWithThreadFallback(ctx, ctx.t("compacting"), threadExtra(ctx.thread));
    const result = await compactThread(ctx.services.repos, ctx.thread, {
      recentWindowMessages: ctx.services.config.RECENT_WINDOW_MESSAGES,
      embedder: ctx.services.embedder,
      summarizer: ctx.services.summarizer,
      imageCaptioner: ctx.services.imageCaptioner,
      logger: ctx.services.logger,
    });
    ctx.thread = (await ctx.services.repos.threads.get(ctx.thread.id)) ?? ctx.thread;
    await ctx.api
      .editMessageText(ctx.chat!.id, status.message_id, ctx.t("compacted", { count: result.count }))
      .catch(() => replyWithThreadFallback(ctx, ctx.t("compacted", { count: result.count }), threadExtra(ctx.thread)));
    await retryLatestUnansweredTurn(ctx);
  });
  bot.command("fork", async (ctx) => {
    logCommand(ctx, "fork");
    if (!ctx.thread || !ctx.user || !ctx.chat) return;
    const me = await ctx.api.getMe();
    if (!(me as { has_topics_enabled?: boolean }).has_topics_enabled) {
      await replyWithThreadFallback(ctx, ctx.t("fork-need-topics"), threadExtra(ctx.thread));
      return;
    }
    const topic = await ctx.api.raw.createForumTopic({
      chat_id: ctx.chat.id,
      name: `Fork: ${ctx.thread.title}`,
    } as never) as { message_thread_id?: number };
    const latest = await ctx.services.repos.messages.latest(ctx.thread.id);
    const fork = await ctx.services.repos.threads.create({
      userId: ctx.user.tg_id,
      topicId: topic.message_thread_id ?? null,
      title: `Fork: ${ctx.thread.title}`,
      parentThreadId: ctx.thread.id,
      forkPointMessageId: latest?.id ?? null,
    });
    ctx.services.logger.info("thread fork created", ctxLogMeta(ctx, {
      forkThreadId: fork.id,
      parentThreadId: ctx.thread.id,
      topicId: fork.topic_id,
    }));
    await replyWithThreadFallback(ctx, ctx.t("fork-created"), threadExtra(fork));
  });
  bot.command("invite", async (ctx) => {
    logCommand(ctx, "invite");
    if (!isAdmin(ctx)) return;
    await replyWithThreadFallback(ctx, inviteDraftText(ctx, 1, "30d"), {
      ...threadExtra(ctx.thread),
      reply_markup: inviteDraftKeyboard(ctx, 1, "30d"),
    });
  });
  bot.command("invites", async (ctx) => {
    logCommand(ctx, "invites");
    if (!isAdmin(ctx)) return;
    const invites = await ctx.services.repos.invites.list();
    ctx.services.logger.debug("invites listed", ctxLogMeta(ctx, { invites: invites.length }));
    if (!invites.length) {
      await replyWithThreadFallback(ctx, ctx.t("invites-empty"), threadExtra(ctx.thread));
      return;
    }
    await replyWithThreadFallback(ctx, 
      invites
        .map((invite) => {
          const status = invite.revoked
            ? ctx.t("invite-status-revoked")
            : invite.expires_at && invite.expires_at < Date.now()
              ? ctx.t("invite-status-expired")
              : ctx.t("invite-status-active");
          const expires = invite.expires_at ? new Date(invite.expires_at).toISOString().slice(0, 10) : ctx.t("invite-exp-never");
          return `${invite.code} · ${invite.used_count}/${invite.max_uses} · ${expires} · ${status}`;
        })
        .join("\n"),
      {
        ...threadExtra(ctx.thread),
        reply_markup: {
          inline_keyboard: invites
            .filter((invite) => !invite.revoked)
            .map((invite) => [{ text: ctx.t("invite-btn-revoke", { code: invite.code }), callback_data: `inv:revoke:${invite.code}` }]),
        },
      },
    );
  });
  bot.callbackQuery(/^inv:revoke:(.+)$/, async (ctx) => {
    logCallback(ctx, "invite:revoke");
    if (!isAdmin(ctx)) return;
    await ctx.services.repos.invites.revoke(ctx.match[1]!);
    ctx.services.logger.info("invite revoked", ctxLogMeta(ctx));
    await ctx.answerCallbackQuery({ text: ctx.t("invite-revoked-toast") });
    await ctx.editMessageText(ctx.t("invite-revoked")).catch(() => undefined);
  });
  bot.callbackQuery(/^inv:set:(\d+):(7d|30d|never)$/, async (ctx) => {
    logCallback(ctx, "invite:set");
    if (!isAdmin(ctx)) return;
    const uses = normalizeInviteUses(ctx.match[1]);
    const expiry = ctx.match[2] as InviteExpiry;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(inviteDraftText(ctx, uses, expiry), {
      reply_markup: inviteDraftKeyboard(ctx, uses, expiry),
    }).catch(() => replyWithThreadFallback(ctx, inviteDraftText(ctx, uses, expiry), {
      ...threadExtra(ctx.thread),
      reply_markup: inviteDraftKeyboard(ctx, uses, expiry),
    }));
  });
  bot.callbackQuery(/^inv:create:(\d+):(7d|30d|never)$/, async (ctx) => {
    logCallback(ctx, "invite:create");
    if (!isAdmin(ctx)) return;
    const uses = normalizeInviteUses(ctx.match[1]);
    const expiry = ctx.match[2] as InviteExpiry;
    const code = await createUniqueInviteCode(ctx.services.repos);
    const expiresAt = expiryDate(expiry);
    const row = await ctx.services.repos.invites.insert({
      code,
      maxUses: uses,
      expiresAt,
      createdBy: ctx.from!.id,
    });
    ctx.services.logger.info("invite created", ctxLogMeta(ctx, {
      maxUses: row.max_uses,
      expiresAt: row.expires_at ?? null,
    }));
    const username = ctx.me.username ?? "your_bot";
    const link = `https://t.me/${username}?start=${row.code}`;
    const html = ctx.t("invite-created", {
      link: escapeHtml(link),
      code: escapeHtml(row.code),
      uses: row.max_uses,
      expires: row.expires_at ? format(row.expires_at, "yyyy-MM-dd") : ctx.t("invite-exp-never"),
    });
    const replyMarkup = {
      inline_keyboard: [[{ text: ctx.t("invite-btn-open"), url: link }]],
    };
    await ctx.answerCallbackQuery({ text: ctx.t("invite-created-toast") });
    await ctx.editMessageText(html, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }).catch(() => replyWithThreadFallback(ctx, html, {
      ...threadExtra(ctx.thread),
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }));
  });
  bot.callbackQuery("ctx:compact", async (ctx) => {
    logCallback(ctx, "ctx:compact");
    if (!ctx.thread) return;
    await ctx.answerCallbackQuery();
    const result = await compactThread(ctx.services.repos, ctx.thread, {
      recentWindowMessages: ctx.services.config.RECENT_WINDOW_MESSAGES,
      embedder: ctx.services.embedder,
      summarizer: ctx.services.summarizer,
      imageCaptioner: ctx.services.imageCaptioner,
      logger: ctx.services.logger,
    });
    ctx.thread = (await ctx.services.repos.threads.get(ctx.thread.id)) ?? ctx.thread;
    await replyWithThreadFallback(ctx, ctx.t("compacted", { count: result.count }), threadExtra(ctx.thread));
    await retryLatestUnansweredTurn(ctx);
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    ctx.services.logger.debug("document message received", ctxLogMeta(ctx, {
      name: doc.file_name ?? "file",
      mime: doc.mime_type ?? null,
      size: doc.file_size ?? null,
    }));
    if ((doc.file_size ?? 0) > MAX_FILE_BYTES) {
      ctx.services.logger.warn("document rejected; too large", ctxLogMeta(ctx, {
        name: doc.file_name ?? "file",
        size: doc.file_size ?? null,
      }));
      await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return;
    }
    const name = doc.file_name ?? "file";
    const type = classifyFile(name, doc.mime_type ?? "");
    if (type === "legacy-doc") {
      ctx.services.logger.info("document rejected; legacy doc unsupported", ctxLogMeta(ctx, { name }));
      await replyWithThreadFallback(ctx, ctx.t("file-doc-legacy"), threadExtra(ctx.thread));
      return;
    }
    if (!type) {
      ctx.services.logger.info("document rejected; unsupported type", ctxLogMeta(ctx, { name, mime: doc.mime_type ?? null }));
      await replyWithThreadFallback(ctx, ctx.t("file-unsupported"), threadExtra(ctx.thread));
      return;
    }
    await handleTelegramFile(ctx, {
      fileId: doc.file_id,
      fileUniqueId: doc.file_unique_id,
      name,
      mime: doc.mime_type,
      caption: ctx.message.caption,
      type,
      size: doc.file_size,
      mediaGroupId: ctx.message.media_group_id,
    });
  });
  bot.on("message:photo", async (ctx) => {
    const photo = [...ctx.message.photo].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    if (!photo) return;
    ctx.services.logger.debug("photo message received", ctxLogMeta(ctx, {
      size: photo.file_size ?? null,
      width: photo.width,
      height: photo.height,
    }));
    if ((photo.file_size ?? 0) > MAX_FILE_BYTES) {
      ctx.services.logger.warn("photo rejected; too large", ctxLogMeta(ctx, { size: photo.file_size ?? null }));
      await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return;
    }
    await handleTelegramFile(ctx, {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      name: `${photo.file_unique_id}.jpg`,
      mime: "image/jpeg",
      caption: ctx.message.caption,
      type: "image",
      size: photo.file_size,
      mediaGroupId: ctx.message.media_group_id,
    });
  });
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      ctx.services.logger.info("unknown command received", ctxLogMeta(ctx));
      await replyWithThreadFallback(ctx, ctx.t("unknown-command"), threadExtra(ctx.thread));
      return;
    }
    ctx.services.logger.debug("text message received", ctxLogMeta(ctx, { chars: ctx.message.text.length }));
    await enqueueUserText(ctx, ctx.message.text);
  });
  bot.on("message", async (ctx) => {
    if (isIgnoredServiceMessage(ctx.message)) {
      ctx.services.logger.debug("service message ignored", ctxLogMeta(ctx));
      return;
    }
    ctx.services.logger.info("unsupported message received", ctxLogMeta(ctx));
    await replyWithThreadFallback(ctx, ctx.t("file-unsupported"), threadExtra(ctx.thread));
  });

  bot.catch((err) => {
    const ctx = err.ctx as BotContext;
    const e = err.error;
    if (e instanceof GrammyError) ctx.services?.logger.error("telegram api error", ctxLogMeta(ctx, { description: e.description }));
    else if (e instanceof HttpError) ctx.services?.logger.error("telegram http error", ctxLogMeta(ctx, { error: String(e) }));
    else ctx.services?.logger.error("bot error", ctxLogMeta(ctx, { error: String(e) }));
  });

  options.logger.info("bot handlers installed");
  return services;
}

function threadSequentializationKey(ctx: BotContext): string | undefined {
  if (isStopCommand(ctx)) return undefined;
  if (!ctx.chat) return undefined;
  return `${ctx.chat.id}:${messageThreadId(ctx) ?? "general"}`;
}

function isStopCommand(ctx: BotContext): boolean {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  return /^\/stop(?:@\w+)?(?:\s|$)/.test(text ?? "");
}

function messageThreadId(ctx: BotContext): number | null {
  return (ctx.msg as { message_thread_id?: number } | undefined)?.message_thread_id ?? null;
}

function ctxLogMeta(ctx: BotContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    updateId: ctx.update.update_id,
    userId: ctx.from?.id ?? null,
    chatId: ctx.chat?.id ?? null,
    threadId: ctx.thread?.id ?? null,
    topicId: ctx.thread?.topic_id ?? messageThreadId(ctx),
    ...extra,
  };
}

function logCommand(ctx: BotContext, command: string): void {
  ctx.services.logger.info("bot command received", ctxLogMeta(ctx, { command }));
}

function logCallback(ctx: BotContext, action: string, extra: Record<string, unknown> = {}): void {
  ctx.services.logger.debug("callback received", ctxLogMeta(ctx, { action, ...extra }));
}

function optionalLogger(ctx: BotContext): Logger | undefined {
  return (ctx as Partial<BotContext>).services?.logger;
}

async function stopActiveFileProcessing(ctx: BotContext): Promise<void> {
  const key = activeFileJobKey(ctx);
  const job = key ? activeFileJobs.get(key) : undefined;
  if (!job) {
    ctx.services.logger.info("file stop requested with no active job", ctxLogMeta(ctx));
    await replyWithThreadFallback(ctx, ctx.t("file-stop-none"), threadExtra(ctx.thread));
    return;
  }
  ctx.services.logger.info("file stop requested", ctxLogMeta(ctx));
  await job.status.updateKey("file-processing-stopping");
  job.controller.abort();
}

async function privateOnly(ctx: BotContext, next: NextFunction): Promise<void> {
  if (ctx.chat && ctx.chat.type !== "private") {
    ctx.services.logger.warn("non-private chat rejected", ctxLogMeta(ctx, { chatType: ctx.chat.type }));
    await replyWithThreadFallback(ctx, ctx.t("private-only")).catch(() => undefined);
    await ctx.leaveChat().catch(() => undefined);
    return;
  }
  await next();
}

async function authAndThread(ctx: BotContext, next: NextFunction): Promise<void> {
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
    const code = text?.startsWith("/start ") ? text.slice(7).trim() : awaitingCode.has(ctx.from.id) ? text?.trim() : undefined;
    if (code) {
      ctx.services.logger.debug("invite code submitted", ctxLogMeta(ctx));
      const ok = await redeemInvite(ctx, code, lang);
      if (ok) {
        user = await ctx.services.repos.users.get(ctx.from.id);
      } else {
        return;
      }
    } else if (text === "/start" || text) {
      awaitingCode.set(ctx.from.id, true);
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

async function redeemInvite(ctx: BotContext, code: string, lang: "en" | "ru"): Promise<boolean> {
  const result = await ctx.services.repos.invites.validate(code);
  if (!result.ok) {
    ctx.services.logger.warn("invite redemption rejected", ctxLogMeta(ctx, { reason: result.reason }));
    await replyWithThreadFallback(ctx, ctx.t(`invite-invalid-${result.reason}`));
    awaitingCode.set(ctx.from!.id, true);
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
  awaitingCode.delete(ctx.from!.id);
  ctx.services.logger.info("invite redeemed", ctxLogMeta(ctx, { lang }));
  return true;
}

async function sendWelcome(ctx: BotContext): Promise<void> {
  await replyRichMarkdownWithThreadFallback(ctx, ctx.t("start-welcome"), threadExtra(ctx.thread));
  if (!ctx.user || ctx.user.tz_offset_min !== null) return;
  await delay(ctx.services.config.ONBOARDING_TIMEZONE_DELAY_MS);
  const user = await ctx.services.repos.users.get(ctx.user.tg_id);
  if (!user || user.tz_offset_min !== null) return;
  ctx.user = user;
  await replyMarkdownWithThreadFallback(ctx, ctx.t("tz-onboarding-prompt"), {
    ...threadExtra(ctx.thread),
    reply_markup: onboardingTimezoneKeyboard(ctx.t, user.lang === "ru"),
  });
}

async function timezoneConversation(conversation: BotConversation, ctx: BotContext): Promise<void> {
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
  try {
    await ctx.reply(data.text, data.other);
  } catch (err) {
    const payload = (data.other ?? {}) as Record<string, unknown>;
    if (!payload.message_thread_id || !data.threadTitle || !isThreadNotFound(err)) throw err;
    const { message_thread_id: _messageThreadId, ...withoutThread } = payload;
    await ctx.reply(prefixPlainForThreadFallback(data.threadTitle, data.text), withoutThread as ReplyOptions);
  }
}

async function handleUserText(
  ctx: BotContext,
  text: string,
  options: {
    userMessageKind?: "text" | "image" | "file" | "system";
    userMessageContent?: unknown;
    onUserMessagePersisted?: (message: MessageRow) => Promise<void>;
  } = {},
): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  if (busyThreads.has(ctx.thread.id)) {
    ctx.services.logger.info("turn queued while thread busy", ctxLogMeta(ctx, {
      kind: options.userMessageKind ?? "text",
      textChars: text.length,
    }));
    const message = await ctx.services.repos.messages.insert({
      threadId: ctx.thread.id,
      role: "user",
      kind: options.userMessageKind,
      content: options.userMessageContent ?? { text },
      textPlain: text,
    });
    await options.onUserMessagePersisted?.(message);
    await replyWithThreadFallback(ctx, ctx.t("busy"), threadExtra(ctx.thread));
    return;
  }
  busyThreads.add(ctx.thread.id);
  const startedAt = Date.now();
  ctx.services.logger.info("turn dispatch starting", ctxLogMeta(ctx, {
    kind: options.userMessageKind ?? "text",
    textChars: text.length,
  }));
  try {
    await ctx.services.turnRunner({
      api: ctx.api,
      chatId: ctx.chat.id,
      messageThreadId: ctx.thread.topic_id ?? undefined,
      config: ctx.services.config,
      db: ctx.services.db,
      repos: ctx.services.repos,
      logger: ctx.services.logger,
      user: ctx.user,
      thread: ctx.thread,
      text,
      userMessageKind: options.userMessageKind,
      userMessageContent: options.userMessageContent,
      onUserMessagePersisted: options.onUserMessagePersisted,
      redownloadFile: async (file) => {
        if (!file.telegram_file_id) throw new Error("missing Telegram file_id");
        return (await ctx.services.downloadFile({
          api: ctx.api,
          config: ctx.services.config,
          fileId: file.telegram_file_id,
        })).bytes;
      },
      embedder: ctx.services.embedder,
      t: ctx.t,
    });
  } finally {
    busyThreads.delete(ctx.thread.id);
    ctx.services.logger.info("turn dispatch finished", ctxLogMeta(ctx, {
      kind: options.userMessageKind ?? "text",
      ms: Date.now() - startedAt,
    }));
  }
}

async function enqueueUserText(ctx: BotContext, text: string): Promise<void> {
  const key = textBurstKey(ctx);
  if (!key) {
    ctx.services.logger.debug("text burst unavailable; dispatching immediately", ctxLogMeta(ctx, { chars: text.length }));
    await handleUserText(ctx, text);
    return;
  }

  const existing = pendingTextBursts.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.ctx = ctx;
    existing.texts.push(text);
    existing.timer = scheduleTextBurstFlush(key, ctx);
    ctx.services.logger.debug("text burst appended", ctxLogMeta(ctx, {
      parts: existing.texts.length,
      chars: existing.texts.reduce((sum, part) => sum + part.length, 0),
    }));
    return;
  }

  if (text.length < splitTextChunkMinChars) {
    ctx.services.logger.debug("text below burst threshold; dispatching immediately", ctxLogMeta(ctx, { chars: text.length }));
    await handleUserText(ctx, text);
    return;
  }

  pendingTextBursts.set(key, {
    ctx,
    texts: [text],
    timer: scheduleTextBurstFlush(key, ctx),
  });
  ctx.services.logger.debug("text burst queued", ctxLogMeta(ctx, { chars: text.length }));
}

function scheduleTextBurstFlush(key: string, ctx: BotContext): NodeJS.Timeout {
  return setTimeout(() => {
    void flushPendingTextBurst(key).catch((err) => {
      ctx.services.logger.error("text burst flush failed", { err: String(err) });
    });
  }, textBurstFlushMs);
}

async function flushPendingTextBurstForContext(ctx: BotContext): Promise<void> {
  const key = textBurstKey(ctx);
  if (!key) return;
  ctx.services.logger.debug("flushing text burst before non-text update", ctxLogMeta(ctx));
  await flushPendingTextBurst(key);
}

async function flushPendingTextBurst(key: string): Promise<void> {
  const pending = pendingTextBursts.get(key);
  if (!pending) return;
  pendingTextBursts.delete(key);
  clearTimeout(pending.timer);

  const text = pending.texts.join("\n\n");
  if (!text) return;
  pending.ctx.services.logger.info("text burst flushed", ctxLogMeta(pending.ctx, {
    parts: pending.texts.length,
    chars: text.length,
  }));
  await handleUserText(pending.ctx, text);
}

function textBurstKey(ctx: BotContext): string | undefined {
  if (!ctx.chat || !ctx.user || !ctx.thread) return undefined;
  return `${ctx.chat.id}:${ctx.user.tg_id}:${ctx.thread.id}`;
}

function isPlainUserText(ctx: BotContext): boolean {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  return typeof text === "string" && !text.startsWith("/");
}

async function retryLatestUnansweredTurn(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  ctx.services.logger.debug("looking for latest unanswered turn", ctxLogMeta(ctx));
  const messages = await ctx.services.repos.messages.listThread(ctx.thread.id);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.text_plain.trim()) return;
    if (message.role === "user") {
      if (message.kind === "image") return;
      ctx.services.logger.info("retrying latest unanswered turn", ctxLogMeta(ctx, { messageId: message.id }));
      await handleUserText(ctx, message.text_plain);
      return;
    }
  }
}

function activeFileJobKey(ctx: BotContext): string | undefined {
  if (!ctx.chat || !ctx.thread) return undefined;
  return `${ctx.chat.id}:${ctx.thread.topic_id ?? "general"}`;
}

class FileProcessingStatus {
  private messageId?: number;
  private lastText = "";

  constructor(
    private readonly ctx: BotContext,
    private readonly name: string,
  ) {}

  updateIngestStage(progress: FileIngestProgress): Promise<void> {
    if (progress.stage === "extracting") return this.updateKey("file-processing-extracting");
    if (progress.stage === "embedding") return this.updateKey("file-processing-embedding", { percent: indexingPercent(progress) });
    return this.updateKey("file-processing-indexing", { percent: indexingPercent(progress) });
  }

  async updateKey(key: string, params: Record<string, string | number> = {}): Promise<void> {
    await this.updateText(this.ctx.t(key, { name: escapeHtml(this.name), ...params }));
  }

  async updateText(text: string): Promise<void> {
    if (text === this.lastText) return;
    if (!this.messageId) {
      try {
        const sent = await replyWithThreadFallback(this.ctx, text, {
          ...threadExtra(this.ctx.thread),
          parse_mode: "HTML",
        });
        this.messageId = sent.message_id;
        this.lastText = text;
      } catch (err) {
        this.ctx.services.logger.warn("failed to send file status message", { err: String(err), name: this.name });
      }
      return;
    }
    if (!this.ctx.chat) return;
    try {
      await this.ctx.api.editMessageText(this.ctx.chat.id, this.messageId, text, { parse_mode: "HTML" });
      this.lastText = text;
    } catch (err) {
      this.ctx.services.logger.warn("failed to edit file status message", { err: String(err), name: this.name });
    }
  }
}

function indexingPercent(progress: FileIngestProgress): number {
  if (!progress.total || progress.total <= 0) return 100;
  const completed = Math.max(0, Math.min(progress.completed ?? 0, progress.total));
  return Math.floor((completed / progress.total) * 100);
}

async function handleTelegramFile(ctx: BotContext, input: TelegramFileInput): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  if (input.type === "image") {
    await handleTelegramImage(ctx, input);
    return;
  }
  const jobKey = activeFileJobKey(ctx);
  if (!jobKey) return;
  if (activeFileJobs.has(jobKey)) {
    ctx.services.logger.info("file job rejected; thread already processing", ctxLogMeta(ctx, {
      name: input.name,
      type: input.type,
    }));
    await replyWithThreadFallback(ctx, ctx.t("busy"), threadExtra(ctx.thread));
    return;
  }
  const controller = new AbortController();
  const status = new FileProcessingStatus(ctx, input.name);
  activeFileJobs.set(jobKey, { controller, status });
  const startedAt = Date.now();
  ctx.services.logger.info("file job starting", ctxLogMeta(ctx, {
    name: input.name,
    type: input.type,
    size: input.size ?? null,
    mediaGroupId: input.mediaGroupId ?? null,
  }));
  const clearJob = () => {
    const current = activeFileJobs.get(jobKey);
    if (current?.controller === controller) activeFileJobs.delete(jobKey);
  };
  try {
    const cached = input.fileUniqueId
      ? await ctx.services.repos.files.findByTelegramFileUniqueId(input.fileUniqueId)
      : undefined;
    if (cached) {
      ctx.services.logger.debug("telegram file cache hit by unique id", ctxLogMeta(ctx, {
        fileId: cached.id,
        name: input.name,
        type: cached.type,
      }));
    }
    const reused = cached?.type === input.type
      ? await prepareCachedTelegramFile(ctx, input, cached, controller.signal, status)
      : undefined;
    if (reused === "too-big") return;
    if (reused) {
      await status.updateKey("file-reused");
      clearJob();
      ctx.services.logger.info("file job reused cached file", ctxLogMeta(ctx, {
        fileId: reused.fileId,
        name: input.name,
        ms: Date.now() - startedAt,
      }));
      await handlePreparedTelegramFile(ctx, input, reused);
      return;
    }

    await status.updateKey("file-processing-downloading");
    ctx.services.logger.debug("telegram file download starting", ctxLogMeta(ctx, { name: input.name, type: input.type }));
    const downloaded = await ctx.services.downloadFile({
      api: ctx.api,
      config: ctx.services.config,
      fileId: input.fileId,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    const bytes = Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
    ctx.services.logger.debug("telegram file download complete", ctxLogMeta(ctx, {
      name: input.name,
      type: input.type,
      bytes: bytes.length,
    }));
    if ((input.size ?? bytes.length) > MAX_FILE_BYTES) {
      ctx.services.logger.warn("downloaded file rejected; too large", ctxLogMeta(ctx, {
        name: input.name,
        type: input.type,
        bytes: bytes.length,
      }));
      await status.updateText(ctx.t("file-too-big"));
      return;
    }
    const contentSha256 = sha256Hex(bytes);
    const cachedByHash = await ctx.services.repos.files.findByContentHash(contentSha256, {
      type: input.type,
      size: bytes.length,
    });
    if (cachedByHash) {
      ctx.services.logger.debug("file cache hit by content hash", ctxLogMeta(ctx, {
        fileId: cachedByHash.id,
        name: input.name,
        type: cachedByHash.type,
      }));
      const hashReused = await prepareCachedTelegramFile(ctx, input, cachedByHash, controller.signal, status, bytes);
      if (hashReused === "too-big") return;
      if (hashReused) {
        await status.updateKey("file-reused");
        clearJob();
        ctx.services.logger.info("file job reused content hash", ctxLogMeta(ctx, {
          fileId: hashReused.fileId,
          name: input.name,
          ms: Date.now() - startedAt,
        }));
        await handlePreparedTelegramFile(ctx, input, hashReused);
        return;
      }
    }
    const ingested = await ingestFileBytes({
      config: ctx.services.config,
      repo: ctx.services.repos.files,
      userId: ctx.user.tg_id,
      threadId: ctx.thread.id,
      bytes,
      name: input.name,
      mime: input.mime,
      telegramFileId: input.fileId,
      telegramFileUniqueId: input.fileUniqueId ?? null,
      contentSha256,
      embeddings: ctx.services.repos.embeddings,
      embedder: ctx.services.embedder,
      logger: ctx.services.logger,
      signal: controller.signal,
      onStage: (stage) => status.updateIngestStage(stage),
    });
    throwIfAborted(controller.signal);
    await ctx.services.repos.files.rememberTelegramFileRef(ingested.fileId, {
      fileUniqueId: input.fileUniqueId ?? null,
      telegramFileId: input.fileId,
    });
    await status.updateKey("file-processed");
    clearJob();
    ctx.services.logger.info("file job complete", ctxLogMeta(ctx, {
      fileId: ingested.fileId,
      name: input.name,
      type: input.type,
      inline: ingested.inline,
      ms: Date.now() - startedAt,
    }));
    await handlePreparedTelegramFile(ctx, input, ingested);
  } catch (err) {
    if (isAbortError(err) || controller.signal.aborted) {
      ctx.services.logger.info("file job cancelled", ctxLogMeta(ctx, { name: input.name, type: input.type }));
      await status.updateKey("file-processing-cancelled");
      return;
    }
    ctx.services.logger.warn("file ingestion failed", { err: String(err), name: input.name });
    const key = input.type === "pdf" || input.type === "docx" ? "docling-down" : "error-generic";
    await status.updateText(ctx.t(key));
  } finally {
    clearJob();
  }
}

async function handleTelegramImage(ctx: BotContext, input: TelegramFileInput): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  const controller = new AbortController();
  const startedAt = Date.now();
  ctx.services.logger.info("image ingest job starting", ctxLogMeta(ctx, {
    name: input.name,
    size: input.size ?? null,
    mediaGroupId: input.mediaGroupId ?? null,
  }));
  try {
    const cached = input.fileUniqueId
      ? await ctx.services.repos.files.findByTelegramFileUniqueId(input.fileUniqueId)
      : undefined;
    if (cached) ctx.services.logger.debug("image cache hit by unique id", ctxLogMeta(ctx, { fileId: cached.id, name: input.name }));
    const reused = cached?.type === "image"
      ? await prepareCachedTelegramFile(ctx, input, cached, controller.signal)
      : undefined;
    if (reused === "too-big") return;
    if (reused) {
      ctx.services.logger.info("image ingest job reused cached image", ctxLogMeta(ctx, {
        fileId: reused.fileId,
        name: input.name,
        ms: Date.now() - startedAt,
      }));
      await handlePreparedTelegramFile(ctx, input, reused);
      return;
    }

    ctx.services.logger.debug("telegram image download starting", ctxLogMeta(ctx, { name: input.name }));
    const downloaded = await ctx.services.downloadFile({
      api: ctx.api,
      config: ctx.services.config,
      fileId: input.fileId,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    const bytes = Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
    ctx.services.logger.debug("telegram image download complete", ctxLogMeta(ctx, { name: input.name, bytes: bytes.length }));
    if ((input.size ?? bytes.length) > MAX_FILE_BYTES) {
      ctx.services.logger.warn("downloaded image rejected; too large", ctxLogMeta(ctx, { name: input.name, bytes: bytes.length }));
      await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return;
    }
    const contentSha256 = sha256Hex(bytes);
    const cachedByHash = await ctx.services.repos.files.findByContentHash(contentSha256, {
      type: "image",
      size: bytes.length,
    });
    if (cachedByHash) {
      ctx.services.logger.debug("image cache hit by content hash", ctxLogMeta(ctx, { fileId: cachedByHash.id, name: input.name }));
      const hashReused = await prepareCachedTelegramFile(ctx, input, cachedByHash, controller.signal, undefined, bytes);
      if (hashReused === "too-big") return;
      if (hashReused) {
        ctx.services.logger.info("image ingest job reused content hash", ctxLogMeta(ctx, {
          fileId: hashReused.fileId,
          name: input.name,
          ms: Date.now() - startedAt,
        }));
        await handlePreparedTelegramFile(ctx, input, hashReused);
        return;
      }
    }
    const ingested = await ingestFileBytes({
      config: ctx.services.config,
      repo: ctx.services.repos.files,
      userId: ctx.user.tg_id,
      threadId: ctx.thread.id,
      bytes,
      name: input.name,
      mime: input.mime,
      telegramFileId: input.fileId,
      telegramFileUniqueId: input.fileUniqueId ?? null,
      contentSha256,
      logger: ctx.services.logger,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    await ctx.services.repos.files.rememberTelegramFileRef(ingested.fileId, {
      fileUniqueId: input.fileUniqueId ?? null,
      telegramFileId: input.fileId,
    });
    ctx.services.logger.info("image ingest job complete", ctxLogMeta(ctx, {
      fileId: ingested.fileId,
      name: input.name,
      ms: Date.now() - startedAt,
    }));
    await handlePreparedTelegramFile(ctx, input, ingested);
  } catch (err) {
    if (isAbortError(err) || controller.signal.aborted) {
      ctx.services.logger.info("image ingest job cancelled", ctxLogMeta(ctx, { name: input.name }));
      return;
    }
    ctx.services.logger.warn("image ingest failed", { err: String(err), name: input.name });
    await replyWithThreadFallback(ctx, ctx.t("error-generic"), threadExtra(ctx.thread));
  }
}

async function prepareCachedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  cached: FileRow,
  signal: AbortSignal,
  status?: FileProcessingStatus,
  restoreBytes?: Buffer,
): Promise<PreparedTelegramFile | "too-big" | undefined> {
  if (!(await fileExists(cached.path))) {
    ctx.services.logger.warn("cached file missing on disk; restoring", ctxLogMeta(ctx, {
      fileId: cached.id,
      path: cached.path,
      name: input.name,
    }));
    let bytes = restoreBytes;
    if (!bytes) {
      await status?.updateKey("file-processing-downloading");
      const downloaded = await ctx.services.downloadFile({
        api: ctx.api,
        config: ctx.services.config,
        fileId: input.fileId,
        signal,
      });
      bytes = Buffer.isBuffer(downloaded.bytes) ? downloaded.bytes : Buffer.from(downloaded.bytes);
    }
    throwIfAborted(signal);
    if ((input.size ?? bytes.length) > MAX_FILE_BYTES) {
      ctx.services.logger.warn("restored cached file rejected; too large", ctxLogMeta(ctx, {
        fileId: cached.id,
        bytes: bytes.length,
      }));
      if (status) await status.updateText(ctx.t("file-too-big"));
      else await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return "too-big";
    }
    await fs.mkdir(path.dirname(cached.path), { recursive: true });
    await fs.writeFile(cached.path, bytes);
    ctx.services.logger.info("cached file restored on disk", ctxLogMeta(ctx, {
      fileId: cached.id,
      bytes: bytes.length,
    }));
  }
  throwIfAborted(signal);
  await ctx.services.repos.files.rememberTelegramFileRef(cached.id, {
    fileUniqueId: input.fileUniqueId ?? null,
    telegramFileId: input.fileId,
  });
  const chunks = cached.is_inline ? [] : await ctx.services.repos.files.chunks(cached.id);
  ctx.services.logger.debug("prepared cached telegram file", ctxLogMeta(ctx, {
    fileId: cached.id,
    inline: Boolean(cached.is_inline),
    chunks: chunks.length,
  }));
  return {
    fileId: cached.id,
    card: cardForFile(cached, chunks, input.name),
    inline: Boolean(cached.is_inline),
    type: input.type,
  };
}

async function handlePreparedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  prepared: PreparedTelegramFile,
): Promise<void> {
  if (input.mediaGroupId) {
    ctx.services.logger.debug("prepared file queued for media group", ctxLogMeta(ctx, {
      groupId: input.mediaGroupId,
      fileId: prepared.fileId,
      type: prepared.type,
    }));
    enqueueMediaGroup(ctx, input.mediaGroupId, {
      caption: input.caption,
      card: prepared.card,
      file: { id: prepared.fileId, type: prepared.type, name: input.name, inline: prepared.inline },
    });
    return;
  }

  if (input.type === "image") {
    await dispatchPreparedImageTurn(ctx, input, prepared);
    return;
  }

  const text = [input.caption, prepared.card].filter((part) => part?.trim()).join("\n\n");
  ctx.services.logger.debug("dispatching prepared file as user turn", ctxLogMeta(ctx, {
    fileId: prepared.fileId,
    type: prepared.type,
    textChars: text.length,
  }));
  await handleUserText(ctx, text, {
    userMessageKind: "file",
    userMessageContent: {
      text,
      caption: input.caption ?? null,
      files: [{ id: prepared.fileId, type: prepared.type, name: input.name, inline: prepared.inline }],
    },
    onUserMessagePersisted: async (message) => {
      await ctx.services.repos.files.setMessageId(prepared.fileId, message.id, {
        displayName: input.name,
        caption: input.caption ?? null,
      });
    },
  });
}

async function dispatchPreparedImageTurn(
  ctx: BotContext,
  input: TelegramFileInput,
  prepared: PreparedTelegramFile,
): Promise<void> {
  const text = [input.caption, prepared.card].filter((part) => part?.trim()).join("\n\n");
  ctx.services.logger.debug("dispatching prepared image as user turn", ctxLogMeta(ctx, {
    fileId: prepared.fileId,
    textChars: text.length,
  }));
  await handleUserText(ctx, text, {
    userMessageKind: "image",
    userMessageContent: {
      text,
      caption: input.caption ?? null,
      files: [{ id: prepared.fileId, type: prepared.type, name: input.name, inline: prepared.inline }],
    },
    onUserMessagePersisted: async (message) => {
      await ctx.services.repos.files.setMessageId(prepared.fileId, message.id, {
        displayName: input.name,
        caption: input.caption ?? null,
      });
    },
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function enqueueMediaGroup(ctx: BotContext, groupId: string, item: PendingMediaGroupItem): void {
  if (!ctx.chat || !ctx.thread) return;
  const key = `${ctx.chat.id}:${ctx.thread.id}:${groupId}`;
  const existing = pendingMediaGroups.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.ctx = ctx;
    existing.items.push(item);
    ctx.services.logger.debug("media group item appended", ctxLogMeta(ctx, {
      groupId,
      items: existing.items.length,
    }));
    existing.timer = setTimeout(() => {
      void flushMediaGroup(key).catch((err) => {
        ctx.services.logger.error("media group flush failed", { err: String(err), groupId });
      });
    }, mediaGroupFlushMs);
    return;
  }

  const pending: PendingMediaGroup = {
    ctx,
    items: [item],
    timer: setTimeout(() => {
      void flushMediaGroup(key).catch((err) => {
        ctx.services.logger.error("media group flush failed", { err: String(err), groupId });
      });
    }, mediaGroupFlushMs),
  };
  pendingMediaGroups.set(key, pending);
  ctx.services.logger.debug("media group queued", ctxLogMeta(ctx, { groupId, items: 1 }));
}

async function flushMediaGroup(key: string): Promise<void> {
  const pending = pendingMediaGroups.get(key);
  if (!pending) return;
  pendingMediaGroups.delete(key);

  const { ctx, items } = pending;
  if (!ctx.user || !ctx.thread || !ctx.chat || items.length === 0) return;
  ctx.services.logger.info("media group flushing", ctxLogMeta(ctx, {
    items: items.length,
    imageItems: items.filter((item) => item.file.type === "image").length,
  }));

  const captions = uniqueNonEmpty(items.map((item) => item.caption));
  const text = [...captions, ...items.map((item) => item.card)].join("\n\n");
  const hasNonImage = items.some((item) => item.file.type !== "image");
  await handleUserText(ctx, text, {
    userMessageKind: hasNonImage ? "file" : "image",
    userMessageContent: {
      text,
      captions,
      files: items.map((item) => item.file),
    },
    onUserMessagePersisted: async (message) => {
      for (const item of items) {
        await ctx.services.repos.files.setMessageId(item.file.id, message.id, {
          displayName: item.file.name,
          caption: item.caption ?? null,
        });
      }
      ctx.services.logger.info("media group file message persisted", ctxLogMeta(ctx, {
        messageId: message.id,
        files: items.length,
      }));
    },
  });
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

type ReplyOptions = Parameters<BotContext["reply"]>[1];

async function replyRichMarkdownWithThreadFallback(
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

async function replyMarkdownWithThreadFallback(
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

async function replyWithThreadFallback(
  ctx: BotContext,
  text: string,
  other?: ReplyOptions,
): ReturnType<BotContext["reply"]> {
  try {
    return await ctx.reply(text, other);
  } catch (err) {
    const payload = (other ?? {}) as Record<string, unknown>;
    if (!payload.message_thread_id || !ctx.thread || !isThreadNotFound(err)) throw err;
    ctx.services.logger.warn("telegram topic reply failed; retrying without message_thread_id", {
      threadId: ctx.thread.id,
      topicId: payload.message_thread_id,
    });
    const { message_thread_id: _messageThreadId, ...withoutThread } = payload;
    return ctx.reply(prefixPlainForThreadFallback(ctx.thread.title, text), withoutThread as ReplyOptions);
  }
}

function prefixPlainForThreadFallback(title: string, text: string): string {
  return `[${title}]\n\n${text}`;
}

async function clearInlineKeyboard(ctx: BotContext): Promise<void> {
  await ctx.editMessageReplyMarkup().catch((err) => {
    ctx.services.logger.debug("failed to clear inline keyboard", { err: String(err) });
  });
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function threadExtra(thread: ThreadRow | undefined) {
  return thread?.topic_id ? { message_thread_id: thread.topic_id } : {};
}

function isAdmin(ctx: BotContext): boolean {
  return ctx.from?.id === ctx.services.config.TELEGRAM_ADMIN_ID;
}

function inviteDraftText(ctx: BotContext, uses: number, expiry: InviteExpiry): string {
  return ctx.t("invite-draft", {
    uses,
    expires: expiryDisplay(ctx, expiry),
  });
}

function inviteDraftKeyboard(ctx: BotContext, uses: number, expiry: InviteExpiry) {
  return {
    inline_keyboard: [
      inviteUseOptions.map((option) => ({
        text: `${option === uses ? "[x] " : ""}${ctx.t("invite-btn-uses", { uses: option })}`,
        callback_data: `inv:set:${option}:${expiry}`,
      })),
      inviteExpiryOptions.map((option) => ({
        text: `${option === expiry ? "[x] " : ""}${ctx.t(`invite-btn-exp-${option}`)}`,
        callback_data: `inv:set:${uses}:${option}`,
      })),
      [{ text: ctx.t("invite-btn-create"), callback_data: `inv:create:${uses}:${expiry}` }],
    ],
  };
}

function normalizeInviteUses(raw: string): number {
  const value = Number(raw);
  return inviteUseOptions.includes(value as typeof inviteUseOptions[number]) ? value : 1;
}

function expiryDate(expiry: InviteExpiry, now = Date.now()): number | null {
  if (expiry === "never") return null;
  const days = expiry === "7d" ? 7 : 30;
  return now + days * 24 * 60 * 60 * 1000;
}

function expiryDisplay(ctx: BotContext, expiry: InviteExpiry): string {
  const expiresAt = expiryDate(expiry);
  return expiresAt ? format(expiresAt, "yyyy-MM-dd") : ctx.t("invite-exp-never");
}

async function createUniqueInviteCode(repos: Repos): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    const code = repos.invites.createCode();
    if (!(await repos.invites.get(code))) return code;
  }
  throw new Error("could not generate a unique invite code");
}

const ignoredServiceMessageKeys = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "message_auto_delete_timer_changed",
  "pinned_message",
] as const;

function isIgnoredServiceMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return ignoredServiceMessageKeys.some((key) => key in message);
}
