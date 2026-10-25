import type { Api } from "grammy";
import { sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import type { BotServices } from "../bot/context.js";
import type { ThreadRow, UserRow } from "../db/types.js";
import type { AcceptedTurnRun } from "../db/repos/turnRuns.js";
import { ingestFileBytes } from "../files/ingest.js";
import { downloadTelegramFile, type TelegramFileDownloader } from "../files/telegram.js";
import { MAX_CHAT_UPLOAD_BYTES, MAX_CHAT_UPLOAD_FILES, MAX_FILE_BYTES } from "../files/limits.js";
import { WebHttpError } from "./auth.js";
import { ConversationRepository, WebNotFound } from "./repository.js";
import type { ChatService, ChatSettings, ChatSettingsPatch, ChatThread, ChatSendResult, ChatUploadFile } from "./chat-types.js";
import { canonicalTimeZone, userOffsetMinutes, zoneOffsetMinutes } from "../bot/timezone.js";
import { webFileSource } from "./file-source.js";
import { deleteUserMemory } from "../memory/view.js";

const sendSchema = z.object({ text: z.string().max(32_000), requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/) });
const settingsSchema = z.object({
  language: z.enum(["en", "ru"]).optional(),
  timeZone: z.string().max(64).nullable().optional(),
  streaming: z.boolean().optional(), memoryEnabled: z.boolean().optional(),
}).strict();

type Avatar = { bytes: Uint8Array; mime: string };
const AVATAR_TTL_MS = 60 * 60_000;
const MAX_CACHED_AVATARS = 256;
const avatarMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export class BotChatService implements ChatService {
  private readonly submitting = new Map<string, Promise<ChatSendResult>>();
  private readonly avatars = new Map<number, { expires: number; value: Promise<Avatar | null> }>();
  constructor(private readonly input: { services: BotServices; repository: ConversationRepository; api: Api; downloadFile?: TelegramFileDownloader }) {}

  private get repos() { return this.input.services.repos; }

  private async user(userId: number): Promise<UserRow> {
    const user = await this.repos.users.get(userId);
    if (!user) throw new WebNotFound();
    return user;
  }

  async profile(userId: number) {
    const user = await this.user(userId);
    return { id: user.tg_id, name: user.first_name, username: user.username };
  }

  /** Cached for an hour and shared by concurrent tabs; a failed lookup is retried on the next request. */
  async avatar(userId: number): Promise<Avatar | null> {
    await this.user(userId);
    const now = Date.now();
    for (const [id, entry] of this.avatars) if (entry.expires <= now) this.avatars.delete(id);
    const cached = this.avatars.get(userId);
    if (cached) return cached.value;
    if (this.avatars.size >= MAX_CACHED_AVATARS) this.avatars.delete(this.avatars.keys().next().value!);
    const entry = { expires: now + AVATAR_TTL_MS, value: this.loadAvatar(userId).catch((error: unknown) => {
      if (this.avatars.get(userId) === entry) this.avatars.delete(userId);
      this.input.services.logger.debug("telegram avatar unavailable", { userId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }) };
    this.avatars.set(userId, entry);
    return entry.value;
  }

  private async loadAvatar(userId: number): Promise<Avatar | null> {
    const signal = AbortSignal.timeout(15_000);
    const photos = await this.input.api.getUserProfilePhotos(userId, { limit: 1 }, signal as Parameters<Api["getUserProfilePhotos"]>[2]);
    const sizes = photos.photos[0];
    if (!sizes?.length) return null;
    // Sizes run from small to large; the first one past 96px stays sharp on high-density screens.
    const size = sizes.find(candidate => candidate.width >= 96) ?? sizes.at(-1)!;
    const { bytes } = await (this.input.downloadFile ?? downloadTelegramFile)({
      api: this.input.api, config: this.input.services.config, fileId: size.file_id, signal, maxBytes: 1024 * 1024,
    });
    const mime = (await fileTypeFromBuffer(bytes))?.mime;
    return mime && avatarMimeTypes.has(mime) ? { bytes, mime } : null;
  }

  private async thread(userId: number, threadId: number): Promise<ThreadRow> {
    const thread = await this.repos.threads.get(threadId);
    if (!thread || thread.user_id !== userId) throw new WebNotFound();
    return thread;
  }

  async requireThread(userId: number, threadId: number): Promise<void> { await this.thread(userId, threadId); }

  async markRead(userId: number, threadId: number, messageId: number) {
    await this.thread(userId, threadId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new WebHttpError(400, "Invalid message ID.");
    const state = await this.repos.threadReads.markRead(userId, threadId, messageId);
    if (!state) throw new WebNotFound();
    return { readMessageId: state.readMessageId, unread: state.unread };
  }

  async threads(userId: number, offset: number, search = "") {
    return this.input.repository.threads(userId, offset, 50, search);
  }

  async history(userId: number, threadId: number, before?: number, after?: number) {
    const thread = await this.thread(userId, threadId);
    const history = await this.input.repository.history(threadId, before, after);
    return { ...history, thread: { ...history.thread, origin: thread.origin, topicId: thread.topic_id },
      draft: this.input.services.turnCoordinator.draft(threadId),
      autoLoadMaxBytes: this.input.services.config.WEB_AUTOLOAD_MAX_BYTES, maxFileBytes: MAX_FILE_BYTES };
  }

  private async createLinkedThread(userId: number, title: string, parent?: { threadId: number; messageId: number | null }): Promise<ThreadRow> {
    let topicId: number | undefined;
    try {
      const me = await this.input.api.getMe();
      if (!me.has_topics_enabled) throw new WebHttpError(409, "Enable topics for this bot in BotFather before creating a conversation.");
      const topic = await this.input.api.createForumTopic(userId, title);
      topicId = topic.message_thread_id;
      return await this.repos.threads.create({ userId, title, topicId, origin: "web",
        titleSource: title === "New conversation" ? "placeholder" : "explicit",
        parentThreadId: parent?.threadId, forkPointMessageId: parent?.messageId });
    } catch (error) {
      if (topicId !== undefined) await this.input.api.deleteForumTopic(userId, topicId).catch(() => undefined);
      if (error instanceof WebHttpError) throw error;
      throw new WebHttpError(502, "Could not create the Telegram topic. Open the bot in Telegram, press Start, and try again.");
    }
  }

  async createThread(userId: number, title = "New conversation"): Promise<ChatThread> {
    await this.user(userId);
    const name = title.trim() || "New conversation";
    if (Array.from(name).length > 128) throw new WebHttpError(400, "Use a conversation title of at most 128 characters.");
    return threadView(await this.createLinkedThread(userId, name));
  }

  async send(userId: number, threadId: number, input: { text: string; requestId: string; files?: ChatUploadFile[] }): Promise<ChatSendResult> {
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) throw new WebHttpError(400, "Enter a message of at most 32,000 characters and a valid request ID.");
    const key = `${userId}:${threadId}:${input.requestId}`;
    const existing = this.submitting.get(key);
    if (existing) return existing;
    const task = this.accept(userId, threadId, input);
    this.submitting.set(key, task);
    try { return await task; } finally { this.submitting.delete(key); }
  }

  private async accept(userId: number, threadId: number, input: { text: string; requestId: string; files?: ChatUploadFile[] }): Promise<ChatSendResult> {
    const thread = await this.thread(userId, threadId);
    const prior = await this.repos.turnRuns.webRequest(userId, threadId, input.requestId);
    if (prior) return sendResult(prior);
    if (thread.archived) throw new WebHttpError(409, "Fork this archived conversation to continue it.");
    const files = input.files ?? [];
    if (!input.text.trim() && !files.length) throw new WebHttpError(400, "Write a message or attach a file.");
    if (files.length > MAX_CHAT_UPLOAD_FILES || files.some(file => file.size > MAX_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > MAX_CHAT_UPLOAD_BYTES) {
      throw new WebHttpError(413, "Attach up to 10 files, each at most 50 MiB (500 MiB total).");
    }
    const user = await this.user(userId);
    const prepared: Awaited<ReturnType<typeof ingestFileBytes>>[] = [];
    const createdIds: number[] = [];
    try {
      for (const file of files) {
        const bytes = Buffer.from(await file.arrayBuffer());
        const result = await ingestFileBytes({ config: this.input.services.config, repo: this.repos.files,
          requireMessage: true,
          userId, threadId, name: file.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 240) || "attachment",
          mime: file.type, bytes, logger: this.input.services.logger });
        createdIds.push(result.fileId);
        await this.input.services.db.db.execute(sql`insert into web_file_blobs(file_id, bytes) values (${result.fileId}, ${bytes})`);
        await this.repos.files.rememberSource(result.fileId, webFileSource(result.fileId, file.type));
        prepared.push(result);
      }
      const text = [input.text.trim(), ...prepared.map(file => file.card)].filter(Boolean).join("\n\n");
      const content = { text, webText: input.text.trim(), caption: input.text.trim(),
        files: prepared.map(file => ({ id: file.fileId, type: file.type, inline: file.inline })) };
      const accepted = await this.input.services.turnCoordinator.accept({
        userId, threadId, chatId: userId, messageThreadId: thread.topic_id, locale: user.lang,
        kind: prepared.length ? (prepared.every(file => file.type === "image") ? "image" : "file") : "text",
        textPlain: text, content, sources: [], webRequestId: input.requestId,
        attachments: prepared.map(file => ({ fileId: file.fileId })),
      });
      return sendResult(accepted);
    } finally {
      // Failed preparations and losing retries never leave unreferenced upload blobs.
      for (const id of createdIds) {
        const file = await this.repos.files.get(id);
        if (file && file.message_id === null) await this.repos.files.deleteFile(id);
      }
    }
  }

  async stop(userId: number, threadId: number): Promise<void> {
    const thread = await this.thread(userId, threadId);
    const state = this.input.services.routerState;
    const key = `${userId}:${thread.topic_id ?? "general"}`;
    state.activeFileJobs.get(key)?.controller.abort();
    await this.input.services.turnCoordinator.cancelActive(threadId);
  }

  async fork(userId: number, threadId: number, messageId?: number): Promise<ChatThread> {
    const thread = await this.thread(userId, threadId);
    const user = await this.user(userId);
    return this.input.services.turnCoordinator.withThreadBarrier(threadId, "fork", async (snapshotId, signal) => {
      const point = messageId ?? snapshotId;
      const { chain } = await this.input.repository.scope(threadId);
      const visible = point === null || point === 0 ? undefined : (await this.repos.messages.listForThreadChain(chain, point)).find(m => m.id === point);
      if (point !== null && point !== 0 && !visible) throw new WebNotFound();
      if (messageId !== undefined && !visible?.pi_entry_id) {
        throw new WebHttpError(409, "This message has no saved model checkpoint. Fork the whole chat or choose an earlier completed reply.");
      }
      signal.throwIfAborted();
      const created = await this.createLinkedThread(userId, Array.from(`Fork: ${thread.title}`).slice(0, 128).join(""), { threadId, messageId: point });
      try {
        await this.input.services.pi.fork(thread, created, user, visible?.pi_entry_id, signal);
        signal.throwIfAborted();
        if (point !== null && point > 0) await this.repos.threadReads.markRead(userId, created.id, point);
        const reads = (await this.repos.threadReads.states(userId, [created.id])).get(created.id);
        return { ...threadView(created), unread: reads?.unread ?? false, lastMessageId: reads?.lastMessageId ?? null };
      } catch (error) {
        await this.repos.threads.archive(created.id);
        if (created.topic_id !== null) await this.input.api.deleteForumTopic(userId, created.topic_id).catch(() => undefined);
        throw error;
      }
    });
  }

  async compact(userId: number, threadId: number): Promise<void> {
    const thread = await this.thread(userId, threadId);
    const user = await this.user(userId);
    await this.input.services.turnCoordinator.withThreadBarrier(threadId, "compact", async (_snapshot, signal) => {
      await this.input.services.pi.compact(thread, user, signal);
    });
  }

  async settings(userId: number): Promise<ChatSettings> {
    const user = await this.user(userId);
    return { language: user.lang, timeZone: user.tz_name, timezoneOffsetMinutes: userOffsetMinutes(user),
      streaming: Boolean(user.stream_mode), memoryEnabled: Boolean(user.memory_enabled) };
  }

  async updateSettings(userId: number, patch: ChatSettingsPatch): Promise<ChatSettings> {
    const parsed = settingsSchema.safeParse(patch);
    if (!parsed.success) throw new WebHttpError(400, "Invalid settings.");
    await this.user(userId);
    const value = parsed.data;
    const zoneChanged = value.timeZone !== undefined;
    const zone = value.timeZone ? canonicalTimeZone(value.timeZone) : null;
    if (value.timeZone && !zone) throw new WebHttpError(400, "Unknown time zone.");
    // A named zone also stores today's offset for readers that only know offsets; clearing it clears both.
    const offset = zone ? zoneOffsetMinutes(zone) : null;
    await this.input.services.db.db.execute(sql`
      update users set lang = coalesce(${value.language ?? null}, lang),
        tz_name = case when ${zoneChanged ? 1 : 0} = 1 then ${zone} else tz_name end,
        tz_offset_min = case when ${zoneChanged ? 1 : 0} = 1 then ${offset} else tz_offset_min end,
        stream_mode = coalesce(${value.streaming === undefined ? null : Number(value.streaming)}, stream_mode),
        memory_enabled = coalesce(${value.memoryEnabled === undefined ? null : Number(value.memoryEnabled)}, memory_enabled)
      where tg_id = ${userId}
    `);
    return this.settings(userId);
  }

  memories(userId: number, offset: number) { return this.input.repository.memories(userId, offset); }
  async deleteMemory(userId: number, memoryId: number): Promise<void> {
    await this.user(userId);
    if (!await deleteUserMemory(this.input.services.db.db, userId, memoryId)) throw new WebNotFound();
  }
  usage(userId: number, days: number, signal?: AbortSignal) { return this.input.repository.usageReport({ userId, days }, signal); }
}

function threadView(thread: ThreadRow): ChatThread {
  return { id: thread.id, userId: thread.user_id, title: thread.title, archived: Boolean(thread.archived),
    parentThreadId: thread.parent_thread_id, forkPointMessageId: thread.fork_point_message_id,
    lastActivity: thread.created_at, activity: null, origin: thread.origin, topicId: thread.topic_id,
    unread: false, lastMessageId: null };
}

function sendResult(accepted: AcceptedTurnRun): ChatSendResult {
  return { turnId: accepted.turnRun.id, messageId: accepted.userMessage.id, queued: accepted.queuedBehind };
}
