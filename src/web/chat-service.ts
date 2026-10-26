import type { Api } from "grammy";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import type { ApplicationServices } from "../application/services.js";
import { ConversationService } from "../application/conversations.js";
import { telegramConversationLink } from "../telegram/conversationLink.js";
import type { FileRow, ThreadRow, UserRow } from "../db/types.js";
import type { AcceptedTurnRun } from "../db/repos/turnRuns.js";
import { ingestFileBytes } from "../files/ingest.js";
import { downloadTelegramFile, type TelegramFileDownloader } from "../files/telegram.js";
import { MAX_CHAT_UPLOAD_BYTES, MAX_CHAT_UPLOAD_FILES, MAX_FILE_BYTES } from "../files/limits.js";
import { WebHttpError } from "./auth.js";
import { ConversationRepository, WebNotFound } from "./repository.js";
import type { ChatService, ChatSettings, ChatSettingsPatch, ChatThread, ChatSendResult, ChatUploadFile } from "./chat-types.js";
import { deleteUserMemory } from "../memory/view.js";

const sendSchema = z.object({ text: z.string().max(32_000), requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/) });
type Avatar = { bytes: Uint8Array; mime: string };
const AVATAR_TTL_MS = 60 * 60_000;
const MAX_CACHED_AVATARS = 256;
const avatarMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export class BotChatService implements ChatService {
  private readonly submitting = new Map<string, Promise<ChatSendResult>>();
  private readonly avatars = new Map<number, { expires: number; value: Promise<Avatar | null> }>();
  private readonly conversations: ConversationService;
  constructor(private readonly input: { services: ApplicationServices; repository: ConversationRepository; api: Api; downloadFile?: TelegramFileDownloader }) {
    this.conversations = new ConversationService(input.services);
  }

  private get repos() { return this.input.services.repos; }

  private async user(userId: number): Promise<UserRow> {
    return this.conversations.user(userId);
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

  private async thread(userId: number, threadId: ThreadRow["id"]): Promise<ThreadRow> {
    return this.conversations.thread(userId, threadId);
  }

  async requireThread(userId: number, threadId: ThreadRow["id"]): Promise<void> { await this.thread(userId, threadId); }

  async markRead(userId: number, threadId: ThreadRow["id"], messageId: number) {
    await this.thread(userId, threadId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new WebHttpError(400, "Invalid message ID.");
    const state = await this.repos.threadReads.markRead(userId, threadId, messageId);
    if (!state) throw new WebNotFound();
    return { readMessageId: state.readMessageId, unread: state.unread };
  }

  async threads(userId: number, offset: number, search = "") {
    await this.user(userId);
    return this.input.repository.threads(userId, offset, 50, search);
  }

  async history(userId: number, threadId: ThreadRow["id"], before?: number, after?: number) {
    const thread = await this.thread(userId, threadId);
    const history = await this.input.repository.history(threadId, before, after);
    return { ...history, thread: { ...history.thread, origin: thread.origin, topicId: thread.topic_id },
      draft: this.input.services.turnCoordinator.draft(threadId),
      autoLoadMaxBytes: this.input.services.config.WEB_AUTOLOAD_MAX_BYTES, maxFileBytes: MAX_FILE_BYTES };
  }

  async createThread(userId: number, title = "New conversation"): Promise<ChatThread> {
    return threadView(await this.conversations.create({ userId, title, origin: "web",
      link: telegramConversationLink(this.input.api, this.input.services.logger) }));
  }

  async send(userId: number, threadId: ThreadRow["id"], input: { text: string; requestId: string; files?: ChatUploadFile[] }): Promise<ChatSendResult> {
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) throw new WebHttpError(400, "Enter a message of at most 32,000 characters and a valid request ID.");
    const key = `${userId}:${threadId}:${input.requestId}`;
    const existing = this.submitting.get(key);
    if (existing) return existing;
    const task = this.accept(userId, threadId, input);
    this.submitting.set(key, task);
    try { return await task; } finally { this.submitting.delete(key); }
  }

  private async accept(userId: number, threadId: ThreadRow["id"], input: { text: string; requestId: string; files?: ChatUploadFile[] }): Promise<ChatSendResult> {
    const thread = await this.thread(userId, threadId);
    const prior = await this.repos.turnRuns.webRequest(userId, threadId, input.requestId);
    if (prior) return sendResult(prior);
    if (thread.archived) throw new WebHttpError(409, "Fork this archived conversation to continue it.");
    const files = input.files ?? [];
    if (!input.text.trim() && !files.length) throw new WebHttpError(400, "Write a message or attach a file.");
    if (files.length > MAX_CHAT_UPLOAD_FILES || files.some(file => file.size > MAX_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > MAX_CHAT_UPLOAD_BYTES) {
      throw new WebHttpError(413, "Attach up to 10 files, each at most 50 MiB (500 MiB total).");
    }
    await this.user(userId);
    const prepared: Awaited<ReturnType<typeof ingestFileBytes>>[] = [];
    const createdIds: FileRow["id"][] = [];
    try {
      for (const file of files) {
        const bytes = Buffer.from(await file.arrayBuffer());
        const result = await ingestFileBytes({ config: this.input.services.config, repo: this.repos.files,
          requireMessage: true,
          userId, threadId, name: file.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 240) || "attachment",
          mime: file.type, bytes, logger: this.input.services.logger });
        createdIds.push(result.fileId);
        const stored = await this.repos.files.get(result.fileId);
        if (!stored) throw new Error("Upload record disappeared.");
        await this.input.services.fileResolver.persistFile(stored, bytes);
        prepared.push(result);
      }
      const text = [input.text.trim(), ...prepared.map(file => file.card)].filter(Boolean).join("\n\n");
      const content = { text, webText: input.text.trim(), caption: input.text.trim(),
        files: prepared.map(file => ({ id: file.fileId, type: file.type, inline: file.inline })) };
      const accepted = await this.conversations.accept({
        userId, threadId, source: { kind: "web", requestId: input.requestId },
        kind: prepared.length ? (prepared.every(file => file.type === "image") ? "image" : "file") : "text",
        text, content,
        attachments: prepared.map(file => ({ fileId: file.fileId })),
      });
      return sendResult(accepted);
    } finally {
      // Failed preparations and losing retries never leave unreferenced upload blobs.
      for (const id of createdIds) {
        if (await this.repos.files.deleteFileIfUnattached(id)) {
          await this.input.services.fileResolver.removeLocalFile(id);
        }
      }
    }
  }

  async stop(userId: number, threadId: ThreadRow["id"]): Promise<void> {
    await this.conversations.stop(userId, threadId);
  }

  async fork(userId: number, threadId: ThreadRow["id"], messageId?: number): Promise<ChatThread> {
    const created = await this.conversations.fork({ userId, threadId, messageId, origin: "web",
      link: telegramConversationLink(this.input.api, this.input.services.logger) });
    const reads = (await this.repos.threadReads.states(userId, [created.id])).get(created.id);
    return { ...threadView(created), unread: reads?.unread ?? false, lastMessageId: reads?.lastMessageId ?? null };
  }

  async compact(userId: number, threadId: ThreadRow["id"]): Promise<{ messageId: number }> {
    const run = await this.conversations.compact(userId, threadId);
    return { messageId: run.messageId };
  }

  settings(userId: number): Promise<ChatSettings> { return this.conversations.settings(userId); }
  updateSettings(userId: number, patch: ChatSettingsPatch): Promise<ChatSettings> {
    return this.conversations.updateSettings(userId, patch);
  }

  async memories(userId: number, offset: number) { await this.user(userId); return this.input.repository.memories(userId, offset); }
  async deleteMemory(userId: number, memoryId: number): Promise<void> {
    await this.user(userId);
    if (!await deleteUserMemory(this.input.services.db.db, userId, memoryId)) throw new WebNotFound();
  }
  async usage(userId: number, days: number, signal?: AbortSignal) { await this.user(userId); return this.input.repository.usageReport({ userId, days }, signal); }
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
