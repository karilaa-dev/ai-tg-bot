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
import { languageKeyboard } from "./keyboards.js";
import { Localizer } from "./i18n.js";
import { cardForFile, classifyFile, ingestFileBytes, type AcceptedFileType, type FileIngestProgress } from "../files/ingest.js";
import { downloadTelegramFile, type TelegramFileDownloader } from "../files/telegram.js";
import { isAbortError, throwIfAborted } from "../files/cancel.js";
import type { TextEmbedder } from "../memory/embeddings.js";
import { isThreadNotFound } from "../telegram/richApi.js";

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
const inviteUseOptions = [1, 5, 10] as const;
const inviteExpiryOptions = ["7d", "30d", "never"] as const;
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

const pendingMediaGroups = new Map<string, PendingMediaGroup>();

export function createBot(options: InstallOptions): Bot<BotContext> {
  const bot = new Bot<BotContext>(options.config.BOT_TOKEN);
  installBot(bot, options);
  return bot;
}

export function installBot(bot: Bot<BotContext>, options: InstallOptions): BotServices {
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

  bot.command("start", async (ctx) => {
    await sendWelcome(ctx);
  });
  bot.command("help", async (ctx) => {
    await replyWithThreadFallback(ctx, ctx.t("help"), threadExtra(ctx.thread));
  });
  bot.command("stop", async (ctx) => {
    await stopActiveFileProcessing(ctx);
  });
  bot.command("lang", async (ctx) => {
    await replyWithThreadFallback(ctx, ctx.t("lang-pick", { lang: ctx.user?.lang ?? "en" }), {
      ...threadExtra(ctx.thread),
      reply_markup: languageKeyboard(),
    });
  });
  bot.callbackQuery(/^lang:(en|ru)$/, async (ctx) => {
    const lang = ctx.match[1] as "en" | "ru";
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
    if (!ctx.user) return;
    const updated = await ctx.services.repos.users.toggleStream(ctx.user.tg_id);
    ctx.user = updated;
    await replyWithThreadFallback(ctx, ctx.t(updated.stream_mode ? "stream-on" : "stream-off"), threadExtra(ctx.thread));
  });
  bot.command("timezone", async (ctx) => {
    if (!ctx.from) return;
    await ctx.conversation.enter("timezone");
  });
  bot.command("compact", async (ctx) => {
    if (!ctx.thread) return;
    const status = await replyWithThreadFallback(ctx, ctx.t("compacting"), threadExtra(ctx.thread));
    const result = await compactThread(ctx.services.repos, ctx.thread, {
      recentWindowMessages: ctx.services.config.RECENT_WINDOW_MESSAGES,
      embedder: ctx.services.embedder,
      summarizer: ctx.services.summarizer,
      logger: ctx.services.logger,
    });
    ctx.thread = (await ctx.services.repos.threads.get(ctx.thread.id)) ?? ctx.thread;
    await ctx.api
      .editMessageText(ctx.chat!.id, status.message_id, ctx.t("compacted", { count: result.count }))
      .catch(() => replyWithThreadFallback(ctx, ctx.t("compacted", { count: result.count }), threadExtra(ctx.thread)));
    await retryLatestUnansweredTurn(ctx);
  });
  bot.command("fork", async (ctx) => {
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
    await replyWithThreadFallback(ctx, ctx.t("fork-created"), threadExtra(fork));
  });
  bot.command("invite", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await replyWithThreadFallback(ctx, inviteDraftText(ctx, 1, "30d"), {
      ...threadExtra(ctx.thread),
      reply_markup: inviteDraftKeyboard(ctx, 1, "30d"),
    });
  });
  bot.command("invites", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const invites = await ctx.services.repos.invites.list();
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
    if (!isAdmin(ctx)) return;
    await ctx.services.repos.invites.revoke(ctx.match[1]!);
    await ctx.answerCallbackQuery({ text: ctx.t("invite-revoked-toast") });
    await ctx.editMessageText(ctx.t("invite-revoked")).catch(() => undefined);
  });
  bot.callbackQuery(/^inv:set:(\d+):(7d|30d|never)$/, async (ctx) => {
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
    if (!ctx.thread) return;
    await ctx.answerCallbackQuery();
    const result = await compactThread(ctx.services.repos, ctx.thread, {
      recentWindowMessages: ctx.services.config.RECENT_WINDOW_MESSAGES,
      embedder: ctx.services.embedder,
      summarizer: ctx.services.summarizer,
      logger: ctx.services.logger,
    });
    ctx.thread = (await ctx.services.repos.threads.get(ctx.thread.id)) ?? ctx.thread;
    await replyWithThreadFallback(ctx, ctx.t("compacted", { count: result.count }), threadExtra(ctx.thread));
    await retryLatestUnansweredTurn(ctx);
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
      await replyWithThreadFallback(ctx, ctx.t("file-too-big"), threadExtra(ctx.thread));
      return;
    }
    const name = doc.file_name ?? "file";
    const type = classifyFile(name, doc.mime_type ?? "");
    if (type === "legacy-doc") {
      await replyWithThreadFallback(ctx, ctx.t("file-doc-legacy"), threadExtra(ctx.thread));
      return;
    }
    if (!type) {
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
    if ((photo.file_size ?? 0) > 20 * 1024 * 1024) {
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
      await replyWithThreadFallback(ctx, ctx.t("unknown-command"), threadExtra(ctx.thread));
      return;
    }
    await handleUserText(ctx, ctx.message.text);
  });
  bot.on("message", async (ctx) => {
    if (isIgnoredServiceMessage(ctx.message)) return;
    await replyWithThreadFallback(ctx, ctx.t("file-unsupported"), threadExtra(ctx.thread));
  });

  bot.catch((err) => {
    const ctx = err.ctx as BotContext;
    const e = err.error;
    if (e instanceof GrammyError) ctx.services?.logger.error("telegram api error", { description: e.description });
    else if (e instanceof HttpError) ctx.services?.logger.error("telegram http error", { error: String(e) });
    else ctx.services?.logger.error("bot error", { error: String(e) });
  });

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

async function stopActiveFileProcessing(ctx: BotContext): Promise<void> {
  const key = activeFileJobKey(ctx);
  const job = key ? activeFileJobs.get(key) : undefined;
  if (!job) {
    await replyWithThreadFallback(ctx, ctx.t("file-stop-none"), threadExtra(ctx.thread));
    return;
  }
  await job.status.updateKey("file-processing-stopping");
  job.controller.abort();
}

async function privateOnly(ctx: BotContext, next: NextFunction): Promise<void> {
  if (ctx.chat && ctx.chat.type !== "private") {
    await replyWithThreadFallback(ctx, ctx.t("private-only")).catch(() => undefined);
    await ctx.leaveChat().catch(() => undefined);
    return;
  }
  await next();
}

async function authAndThread(ctx: BotContext, next: NextFunction): Promise<void> {
  if (!ctx.from) {
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
  }
  if (!user) {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
    const code = text?.startsWith("/start ") ? text.slice(7).trim() : awaitingCode.has(ctx.from.id) ? text?.trim() : undefined;
    if (code) {
      const ok = await redeemInvite(ctx, code, lang);
      if (ok) {
        user = await ctx.services.repos.users.get(ctx.from.id);
      } else {
        return;
      }
    } else if (text === "/start" || text) {
      awaitingCode.set(ctx.from.id, true);
      await replyWithThreadFallback(ctx, ctx.t("invite-ask"));
      return;
    } else {
      return;
    }
  }
  if (!user) return;
  const knownUser = user;
  ctx.user = knownUser;
  if (ctx.chat) {
    const topicId = ctx.msg?.message_thread_id ?? null;
    ctx.thread = await ctx.services.repos.threads.activeForUserTopic(knownUser.tg_id, topicId, topicId ? `Topic ${topicId}` : "General");
  }
  await next();
}

async function redeemInvite(ctx: BotContext, code: string, lang: "en" | "ru"): Promise<boolean> {
  const result = await ctx.services.repos.invites.validate(code);
  if (!result.ok) {
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
  return true;
}

async function sendWelcome(ctx: BotContext): Promise<void> {
  const stream = ctx.t(ctx.user?.stream_mode ? "stream-state-on" : "stream-state-off");
  await replyWithThreadFallback(ctx, ctx.t("start-welcome", { stream }), threadExtra(ctx.thread));
  await replyWithThreadFallback(ctx, ctx.t("lang-pick", { lang: ctx.user?.lang ?? "en" }), {
    ...threadExtra(ctx.thread),
    reply_markup: languageKeyboard(),
  });
}

async function timezoneConversation(conversation: BotConversation, ctx: BotContext): Promise<void> {
  await conversationReply(conversation, ctx, (ctx) => replyData(ctx, ctx.t("tz-ask")));
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const answer = await conversation.waitFor("message:text");
    const text = answer.message.text;
    const offset = offsetFromLocalTime(text);
    if (offset === null) {
      await conversationReply(conversation, answer, (ctx) => replyData(ctx, ctx.t("tz-bad-format")));
      continue;
    }
    const data = await conversation.external(async (ctx) => {
      await ctx.services.repos.users.setTimezone(ctx.from!.id, offset);
      return replyData(ctx, ctx.t("tz-set", { offset: formatUtcOffset(offset), time: text }));
    });
    await replyWithCapturedThreadFallback(answer, data);
    return;
  }
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

function replyData(ctx: BotContext, text: string, other = threadExtra(ctx.thread)): ConversationReplyData {
  return { text, other, threadTitle: ctx.thread?.title };
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
  }
}

async function retryLatestUnansweredTurn(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  const messages = await ctx.services.repos.messages.listThread(ctx.thread.id);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.text_plain.trim()) return;
    if (message.role === "user") {
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
    return this.updateKey("file-processing-indexing", { percent: indexingPercent(progress) });
  }

  async updateKey(key: string, params: Record<string, string | number> = {}): Promise<void> {
    await this.updateText(this.ctx.t(key, { name: this.name, ...params }));
  }

  async updateText(text: string): Promise<void> {
    if (text === this.lastText) return;
    if (!this.messageId) {
      try {
        const sent = await replyWithThreadFallback(this.ctx, text, threadExtra(this.ctx.thread));
        this.messageId = sent.message_id;
        this.lastText = text;
      } catch (err) {
        this.ctx.services.logger.warn("failed to send file status message", { err: String(err), name: this.name });
      }
      return;
    }
    if (!this.ctx.chat) return;
    try {
      await this.ctx.api.editMessageText(this.ctx.chat.id, this.messageId, text);
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
  const jobKey = activeFileJobKey(ctx);
  if (!jobKey) return;
  if (activeFileJobs.has(jobKey)) {
    await replyWithThreadFallback(ctx, ctx.t("busy"), threadExtra(ctx.thread));
    return;
  }
  const controller = new AbortController();
  const status = new FileProcessingStatus(ctx, input.name);
  activeFileJobs.set(jobKey, { controller, status });
  const clearJob = () => {
    const current = activeFileJobs.get(jobKey);
    if (current?.controller === controller) activeFileJobs.delete(jobKey);
  };
  try {
    const cached = input.fileUniqueId
      ? await ctx.services.repos.files.findByTelegramFileUniqueId(input.fileUniqueId)
      : undefined;
    const reused = cached?.type === input.type
      ? await prepareCachedTelegramFile(ctx, input, cached, controller.signal, status)
      : undefined;
    if (reused === "too-big") return;
    if (reused) {
      await status.updateKey("file-reused", { id: reused.fileId });
      clearJob();
      await handlePreparedTelegramFile(ctx, input, reused);
      return;
    }

    await status.updateKey("file-processing-downloading");
    const downloaded = await ctx.services.downloadFile({
      api: ctx.api,
      config: ctx.services.config,
      fileId: input.fileId,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    if ((input.size ?? downloaded.bytes.length) > 20 * 1024 * 1024) {
      await status.updateText(ctx.t("file-too-big"));
      return;
    }
    const imageSummary = input.type === "image"
      ? await captionImage(ctx, downloaded.bytes, input.name, input.mime, controller.signal, status)
      : null;
    throwIfAborted(controller.signal);
    const ingested = await ingestFileBytes({
      config: ctx.services.config,
      repo: ctx.services.repos.files,
      userId: ctx.user.tg_id,
      threadId: ctx.thread.id,
      bytes: downloaded.bytes,
      name: input.name,
      mime: input.mime,
      telegramFileId: input.fileId,
      telegramFileUniqueId: input.fileUniqueId ?? null,
      imageSummary,
      embeddings: ctx.services.repos.embeddings,
      embedder: ctx.services.embedder,
      logger: ctx.services.logger,
      signal: controller.signal,
      onStage: (stage) => status.updateIngestStage(stage),
    });
    throwIfAborted(controller.signal);
    await status.updateKey("file-processed", { id: ingested.fileId });
    clearJob();
    await handlePreparedTelegramFile(ctx, input, ingested);
  } catch (err) {
    if (isAbortError(err) || controller.signal.aborted) {
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

async function prepareCachedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  cached: FileRow,
  signal: AbortSignal,
  status: FileProcessingStatus,
): Promise<PreparedTelegramFile | "too-big" | undefined> {
  if (!(await fileExists(cached.path))) {
    await status.updateKey("file-processing-downloading");
    const downloaded = await ctx.services.downloadFile({
      api: ctx.api,
      config: ctx.services.config,
      fileId: input.fileId,
      signal,
    });
    throwIfAborted(signal);
    if ((input.size ?? downloaded.bytes.length) > 20 * 1024 * 1024) {
      await status.updateText(ctx.t("file-too-big"));
      return "too-big";
    }
    await fs.mkdir(path.dirname(cached.path), { recursive: true });
    await fs.writeFile(cached.path, downloaded.bytes);
  }
  throwIfAborted(signal);
  await ctx.services.repos.files.updateTelegramFileId(cached.id, input.fileId);
  const chunks = cached.is_inline ? [] : await ctx.services.repos.files.chunks(cached.id);
  return {
    fileId: cached.id,
    card: cardForFile(cached, chunks, input.name),
    inline: Boolean(cached.is_inline),
    type: cached.type,
  };
}

async function handlePreparedTelegramFile(
  ctx: BotContext,
  input: TelegramFileInput,
  prepared: PreparedTelegramFile,
): Promise<void> {
  if (input.mediaGroupId) {
    enqueueMediaGroup(ctx, input.mediaGroupId, {
      caption: input.caption,
      card: prepared.card,
      file: { id: prepared.fileId, type: prepared.type, name: input.name, inline: prepared.inline },
    });
    return;
  }

  const text = [input.caption, prepared.card].filter((part) => part?.trim()).join("\n\n");
  await handleUserText(ctx, text, {
    userMessageKind: input.type === "image" ? "image" : "file",
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
}

async function flushMediaGroup(key: string): Promise<void> {
  const pending = pendingMediaGroups.get(key);
  if (!pending) return;
  pendingMediaGroups.delete(key);

  const { ctx, items } = pending;
  if (!ctx.user || !ctx.thread || !ctx.chat || items.length === 0) return;

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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function captionImage(
  ctx: BotContext,
  bytes: Buffer,
  name: string,
  mime: string | undefined,
  signal: AbortSignal,
  status: FileProcessingStatus,
): Promise<string | null> {
  await status.updateKey("file-processing-captioning");
  throwIfAborted(signal);
  if (!ctx.services.imageCaptioner) return null;
  let vision: string;
  try {
    vision = await ctx.services.imageCaptioner.caption({ bytes, name, mime });
    throwIfAborted(signal);
  } catch (err) {
    if (isAbortError(err)) throw err;
    ctx.services.logger.warn("image captioner failed", { err: String(err), name });
    return null;
  }
  return vision || null;
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
