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
import type { TextEmbedder } from "../memory/embeddings.js";
import { PiRuntimeManager, type PiRuntimeService } from "../pi/runtime.js";
import {
  clearInlineKeyboard,
  editOrReply,
  replyMarkdownWithThreadFallback,
  replyWithThreadFallback,
  threadExtra,
} from "./replies.js";
import { ctxLogMeta, logCallback, logCommand, messageThreadId } from "./logging.js";
import { handleUserText } from "./turns.js";
import { enqueueUserText, flushPendingTextBurstForContext, isPlainUserText } from "./batching.js";
import { handleTelegramFile, stopActiveFileProcessing } from "./files.js";
import { initializeUserAndThread, isStopCommand, privateOnly } from "./auth.js";
import { sendWelcome, timezoneConversation } from "./onboarding.js";
import { FileByteCache } from "../files/cache.js";
import { FileResolver } from "../files/resolver.js";
import { TELEGRAM_CONNECTION_KEY, TelegramFileSourceAdapter } from "../files/telegramSource.js";
import { ManagedFileStore } from "../files/storage.js";
import { ThreadTitleCoordinator } from "./threadTitles.js";
import type { CommandRuntime } from "../sandbox/types.js";

interface InstallOptions {
  config: AppConfig;
  db: AppDatabase;
  logger: Logger;
  repos?: Repos;
  localizer?: Localizer;
  turnRunner?: TurnRunner;
  downloadFile?: TelegramFileDownloader;
  fileResolver?: FileResolver;
  embedder?: TextEmbedder;
  commandRuntime?: CommandRuntime;
  pi?: PiRuntimeService;
}

const moscowTimezoneOffsetMin = 180;

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
    hasPiRuntime: Boolean(options.pi),
  });
  const repos = options.repos ?? createRepos(options.db.db, options.db.search);
  const localizer = options.localizer ?? new Localizer();
  const pi = options.pi ?? new PiRuntimeManager({
    config: options.config,
    db: options.db,
    repos,
    logger: options.logger,
    embedder: options.embedder,
    commandRuntime: options.commandRuntime,
  });
  const downloadFile = options.downloadFile ?? downloadTelegramFile;
  const fileResolver = options.fileResolver ?? new FileResolver(
    repos.files,
    new FileByteCache(options.config),
    new ManagedFileStore(options.config),
  );
  if (!fileResolver.registry.get({ transport: "telegram", connectionKey: TELEGRAM_CONNECTION_KEY })) {
    fileResolver.registry.register(new TelegramFileSourceAdapter({
      api: bot.api,
      config: options.config,
      download: downloadFile,
    }));
  }
  const services: BotServices = {
    config: options.config,
    db: options.db,
    repos,
    logger: options.logger,
    turnRunner: options.turnRunner ?? runTurn,
    fileResolver,
    embedder: options.embedder,
    pi,
    threadTitles: new ThreadTitleCoordinator({ repos, pi, logger: options.logger }),
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
    const fileStopped = await stopActiveFileProcessing(ctx, true);
    const turnStopped = ctx.thread ? await ctx.services.pi.abort(ctx.thread.id) : false;
    if (!fileStopped && !turnStopped) {
      await replyWithThreadFallback(ctx, ctx.t("stop-none"), threadExtra(ctx.thread));
    } else if (turnStopped) {
      await replyWithThreadFallback(ctx, ctx.t("turn-stopping"), threadExtra(ctx.thread));
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
    if (!ctx.thread) return;
    const status = await replyWithThreadFallback(ctx, ctx.t("compacting"), threadExtra(ctx.thread));
    const count = await runCompaction(ctx, ctx.thread);
    await ctx.api
      .editMessageText(ctx.chat!.id, status.message_id, ctx.t("compacted", { count }))
      .catch(() => replyWithThreadFallback(ctx, ctx.t("compacted", { count }), threadExtra(ctx.thread)));
  });
  bot.command("fork", async (ctx) => {
    logCommand(ctx, "fork");
    if (!ctx.thread || !ctx.user || !ctx.chat) return;
    const me = await ctx.api.getMe();
    if (!me.has_topics_enabled) {
      await replyWithThreadFallback(ctx, ctx.t("fork-need-topics"), threadExtra(ctx.thread));
      return;
    }
    const topic = await ctx.api.raw.createForumTopic({
      chat_id: ctx.chat.id,
      name: `Fork: ${ctx.thread.title}`,
    });
    const latest = await ctx.services.repos.messages.latest(ctx.thread.id);
    const fork = await ctx.services.repos.threads.create({
      userId: ctx.user.tg_id,
      topicId: topic.message_thread_id ?? null,
      title: `Fork: ${ctx.thread.title}`,
      parentThreadId: ctx.thread.id,
      forkPointMessageId: latest?.id ?? null,
    });
    await ctx.services.pi.fork(ctx.thread, fork, ctx.user, latest?.pi_entry_id);
    ctx.services.logger.info("thread fork created", ctxLogMeta(ctx, {
      forkThreadId: fork.id,
      parentThreadId: ctx.thread.id,
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

async function runCompaction(ctx: BotContext, thread: ThreadRow): Promise<number> {
  if (!ctx.user) return 0;
  const count = await ctx.services.pi.compact(thread, ctx.user);
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
