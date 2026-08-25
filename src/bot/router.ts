import { Bot, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { conversations, createConversation } from "@grammyjs/conversations";
import { sequentialize } from "@grammyjs/runner";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { createRepos, type Repos } from "../db/repos/index.js";
import type { Locale, ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import { runTurn, type TurnRunner } from "../ai/run.js";
import { formatUtcOffset } from "./timezone.js";
import type { BotContext, BotServices } from "./context.js";
import { createRouterState } from "./context.js";
import { localizedCommands } from "./commands.js";
import { languageKeyboard } from "./keyboards.js";
import { Localizer } from "./i18n.js";
import { classifyFile } from "../files/ingest.js";
import { downloadTelegramFile, type TelegramFileDownloader } from "../files/telegram.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { PiRuntimeManager, type PiRuntimeService } from "../pi/runtime.js";
import {
  clearInlineKeyboard,
  editOrReply,
  replyMarkdownWithThreadFallback,
  replyWithThreadFallback,
  threadExtra,
} from "./replies.js";
import { ctxLogMeta, logCallback, logCommand, messageThreadId } from "./logging.js";
import {
  cancelPendingTextBurstForContext,
  enqueueUserText,
  flushPendingTextBurstForContext,
  isPlainUserText,
} from "./batching.js";
import { handleTelegramFile, stopActiveFileProcessing } from "./files.js";
import { initializeUserAndThread, isStopCommand, privateOnly } from "./auth.js";
import { sendWelcome, timezoneConversation } from "./onboarding.js";
import { FileResolver } from "../files/resolver.js";
import { TELEGRAM_CONNECTION_KEY, TelegramFileSourceAdapter } from "../files/telegramSource.js";
import { E2BFileSourceAdapter } from "../e2b/fileSource.js";
import { ThreadTitleCoordinator } from "./threadTitles.js";
import type { CommandRuntime } from "../sandbox/types.js";
import { ThreadTurnCoordinator } from "../ai/threadTurnCoordinator.js";

interface InstallOptions {
  config: AppConfig;
  db: AppDatabase;
  logger: Logger;
  repos?: Repos;
  localizer?: Localizer;
  turnRunner?: TurnRunner;
  downloadFile?: TelegramFileDownloader;
  fileResolver?: FileResolver;
  commandRuntime?: CommandRuntime;
  pi?: PiRuntimeService;
  awaitTurnProcessingOnAccept?: boolean;
}

const moscowTimezoneOffsetMin = 180;

export function createBot(options: InstallOptions): Bot<BotContext> {
  const bot = new Bot<BotContext>(options.config.BOT_TOKEN);
  const services = installBot(bot, options);
  return Object.assign(bot, { services });
}

export function installBot(bot: Bot<BotContext>, options: InstallOptions): BotServices {
  options.logger.info("installing bot handlers", {
    hasCustomRepos: Boolean(options.repos),
    hasCustomLocalizer: Boolean(options.localizer),
    hasCustomTurnRunner: Boolean(options.turnRunner),
    hasPiRuntime: Boolean(options.pi),
  });
  const repos = options.repos ?? createRepos(options.db.db, options.db.search);
  const localizer = options.localizer ?? new Localizer();
  const pi = options.pi ?? new PiRuntimeManager({
    config: options.config,
    db: options.db,
    repos,
    logger: options.logger,
    commandRuntime: options.commandRuntime,
  });
  const downloadFile = options.downloadFile ?? downloadTelegramFile;
  const fileResolver = options.fileResolver ?? new FileResolver(
    repos.files,
  );
  if (!fileResolver.registry.get({ transport: "telegram", connectionKey: TELEGRAM_CONNECTION_KEY })) {
    fileResolver.registry.register(new TelegramFileSourceAdapter({
      api: bot.api,
      config: options.config,
      download: downloadFile,
    }));
  }
  if (
    options.commandRuntime
    && !fileResolver.registry.get({
      transport: "e2b",
      connectionKey: options.config.E2B_DEPLOYMENT_ID,
    })
  ) {
    fileResolver.registry.register(new E2BFileSourceAdapter(options.config, options.commandRuntime));
  }
  const threadTitles = new ThreadTitleCoordinator({ repos, pi, logger: options.logger });
  const turnRunner = options.turnRunner ?? runTurn;
  const turnCoordinator = new ThreadTurnCoordinator({
    api: bot.api,
    config: options.config,
    db: options.db,
    repos,
    logger: options.logger,
    pi,
    fileResolver,
    turnRunner,
    t: (locale, key, params) => localizer.t(locale, key, params),
    scheduleThreadTitle: (input) => threadTitles.schedule({
      api: bot.api,
      chatId: input.chatId,
      threadId: input.threadId,
    }),
    awaitProcessingOnAccept: options.awaitTurnProcessingOnAccept,
  });
  const services: BotServices = {
    config: options.config,
    db: options.db,
    repos,
    logger: options.logger,
    turnRunner,
    turnCoordinator,
    fileResolver,
    commandRuntime: options.commandRuntime,
    pi,
    threadTitles,
    routerState: createRouterState(),
  };

  bot.api.config.use(autoRetry());
  bot.use(async (ctx, next) => {
    ctx.services = services;
    ctx.t = (key, params) => localizer.t(ctx.user?.lang ?? ctx.from?.language_code, key, params);
    await next();
  });
  bot.use(sequentialize<BotContext>(threadSequentializationKey));
  bot.use(privateOnly);
  bot.use(initializeUserAndThread);
  bot.use(conversations<BotContext, BotContext>());
  bot.use(createConversation<BotContext, BotContext>(timezoneConversation, "timezone"));
  bot.use(async (ctx, next) => {
    if (!isPlainUserText(ctx) && !isStopCommand(ctx)) {
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
    const textStopped = cancelPendingTextBurstForContext(ctx);
    const fileStopped = await stopActiveFileProcessing(ctx, true);
    const turnStopped = ctx.thread ? await ctx.services.turnCoordinator.cancelActive(ctx.thread.id) : false;
    if (!textStopped && !fileStopped && !turnStopped) {
      await replyWithThreadFallback(ctx, ctx.t("stop-none"), threadExtra(ctx.thread));
    } else if (turnStopped) {
      await replyWithThreadFallback(ctx, ctx.t("turn-stopping"), threadExtra(ctx.thread));
    } else if (textStopped) {
      await replyWithThreadFallback(ctx, ctx.t("turn-pending-cancelled"), threadExtra(ctx.thread));
    }
  });
  bot.command("lang", async (ctx) => {
    logCommand(ctx, "lang");
    await replyWithThreadFallback(ctx, ctx.t("lang-pick", { lang: ctx.user?.lang ?? "en" }), {
      ...threadExtra(ctx.thread),
      reply_markup: languageKeyboard(),
    });
  });
  bot.callbackQuery(/^lang:(en|ru)$/, async (ctx) => {
    const lang = ctx.match[1] as Locale;
    logCallback(ctx, "lang:set", { lang });
    if (ctx.user) {
      await ctx.services.repos.users.setLang(ctx.user.tg_id, lang);
      ctx.user = { ...ctx.user, lang };
    }
    if (ctx.chat) {
      await ctx.api.setMyCommands(localizedCommands(lang), { scope: { type: "chat", chat_id: ctx.chat.id } });
    }
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, ctx.t("lang-set"));
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
    const thread = ctx.thread;
    if (!thread) return;
    const status = await replyWithThreadFallback(ctx, ctx.t("compacting"), threadExtra(thread));
    const count = await ctx.services.turnCoordinator.withThreadBarrier(
      thread.id,
      "compact",
      async (_snapshotMessageId, signal) => runCompaction(ctx, thread, signal),
    );
    await ctx.api
      .editMessageText(ctx.chat!.id, status.message_id, ctx.t("compacted", { count }))
      .catch(() => replyWithThreadFallback(ctx, ctx.t("compacted", { count }), threadExtra(ctx.thread)));
  });
  bot.command("fork", async (ctx) => {
    logCommand(ctx, "fork");
    const { thread, user, chat } = ctx;
    if (!thread || !user || !chat) return;
    const me = await ctx.api.getMe();
    if (!me.has_topics_enabled) {
      await replyWithThreadFallback(ctx, ctx.t("fork-need-topics"), threadExtra(thread));
      return;
    }
    const fork = await ctx.services.turnCoordinator.withThreadBarrier(thread.id, "fork", async (snapshotMessageId, signal) => {
      let topicId: number | undefined;
      let created: ThreadRow | undefined;
      try {
        signal.throwIfAborted();
        const topic = await ctx.api.raw.createForumTopic({
          chat_id: chat.id,
          name: `Fork: ${thread.title}`,
        });
        topicId = topic.message_thread_id;
        signal.throwIfAborted();
        const latest = snapshotMessageId === null
          ? undefined
          : await ctx.services.repos.messages.get(snapshotMessageId);
        signal.throwIfAborted();
        created = await ctx.services.repos.threads.create({
          userId: user.tg_id,
          topicId,
          title: `Fork: ${thread.title}`,
          parentThreadId: thread.id,
          forkPointMessageId: snapshotMessageId,
        });
        signal.throwIfAborted();
        await ctx.services.pi.fork(thread, created, user, latest?.pi_entry_id, signal);
        signal.throwIfAborted();
        return created;
      } catch (error) {
        const cleanup = await Promise.allSettled([
          created ? ctx.services.repos.threads.archive(created.id) : Promise.resolve(),
          topicId === undefined
            ? Promise.resolve()
            : ctx.api.raw.deleteForumTopic({ chat_id: chat.id, message_thread_id: topicId }),
        ]);
        const cleanupFailures = cleanup.filter((result) => result.status === "rejected");
        ctx.services.logger.warn("partial thread fork rolled back", ctxLogMeta(ctx, {
          forkThreadId: created?.id,
          topicId,
          cleanupFailures: cleanupFailures.length,
          error: String(error),
        }));
        throw error;
      }
    });
    ctx.services.logger.info("thread fork created", ctxLogMeta(ctx, {
      forkThreadId: fork.id,
      parentThreadId: thread.id,
      topicId: fork.topic_id,
    }));
    await replyWithThreadFallback(ctx, ctx.t("fork-created"), threadExtra(fork));
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
      mediaKind: "document",
      size: doc.file_size,
      mediaGroupId: ctx.message.media_group_id,
      telegramRefs: [{
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        size: doc.file_size,
        primary: true,
      }],
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
      mediaKind: "photo",
      size: photo.file_size,
      mediaGroupId: ctx.message.media_group_id,
      telegramRefs: ctx.message.photo.map((size) => ({
        fileId: size.file_id,
        fileUniqueId: size.file_unique_id,
        width: size.width,
        height: size.height,
        size: size.file_size,
        primary: size.file_id === photo.file_id,
      })),
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

async function runCompaction(ctx: BotContext, thread: ThreadRow, signal: AbortSignal): Promise<number> {
  if (!ctx.user) return 0;
  const count = await ctx.services.pi.compact(thread, ctx.user, signal);
  signal.throwIfAborted();
  ctx.thread = (await ctx.services.repos.threads.get(thread.id)) ?? thread;
  return count;
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
