import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DurableTurnAttachment, TelegramTurnSource } from "../db/repos/turnRuns.js";
import type { MessageKind, ThreadRow, UserRow } from "../db/types.js";
import { canonicalTimeZone, userOffsetMinutes, zoneOffsetMinutes } from "../bot/timezone.js";
import type { ApplicationServices } from "./services.js";
import { ConversationError } from "./errors.js";
import { compactionDescription, type CompactionAction } from "./compactionAction.js";
import { CompactionGuardError } from "../pi/compactionPolicy.js";

export interface CompactionRun { messageId: number; completion: Promise<number> }

const settingsSchema = z.object({
  language: z.enum(["en", "ru"]).optional(),
  timeZone: z.string().max(64).nullable().optional(),
  streaming: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
}).strict();

export type ConversationSettingsPatch = z.infer<typeof settingsSchema>;

/** A frontend may link a conversation to its own channel without owning it. */
export interface ConversationLink {
  create(userId: number, title: string): Promise<number | null>;
  remove(userId: number, topicId: number): Promise<void>;
}

export type ConversationSource =
  | { kind: "telegram"; chatId: number; updates: TelegramTurnSource[] }
  | { kind: "web"; requestId: string };

export class ConversationService {
  private readonly compactions = new Map<string, Promise<CompactionRun>>();
  constructor(private readonly services: ApplicationServices) {}

  async user(userId: number) {
    if (!await this.services.access.isAllowed(userId)) throw new ConversationError(403, "This account is not allowed to use the bot.");
    const user = await this.services.repos.users.get(userId);
    if (!user) throw new ConversationError(404, "Start the bot in Telegram to register your account.");
    return user;
  }

  async thread(userId: number, threadId: ThreadRow["id"]) {
    await this.user(userId);
    const thread = await this.services.repos.threads.get(threadId);
    if (!thread || thread.user_id !== userId) throw new ConversationError(404, "Conversation not found.");
    return thread;
  }

  async create(input: {
    userId: number; title: string; origin: ThreadRow["origin"]; link?: ConversationLink;
    parent?: { threadId: ThreadRow["id"]; messageId: number | null };
  }): Promise<ThreadRow> {
    await this.user(input.userId);
    const title = input.title.trim() || "New conversation";
    if (Array.from(title).length > 128) throw new ConversationError(400, "Use a conversation title of at most 128 characters.");
    const topicId = await input.link?.create(input.userId, title) ?? null;
    try {
      await this.user(input.userId);
      return await this.services.repos.threads.create({
        userId: input.userId, title, topicId, origin: input.origin,
        titleSource: title === "New conversation" ? "placeholder" : "explicit",
        parentThreadId: input.parent?.threadId, forkPointMessageId: input.parent?.messageId,
      });
    } catch (error) {
      if (topicId !== null) await input.link?.remove(input.userId, topicId).catch(() => undefined);
      throw error;
    }
  }

  async accept(input: {
    userId: number; threadId: ThreadRow["id"]; source: ConversationSource;
    kind: MessageKind; content: unknown; text: string;
    attachments?: DurableTurnAttachment[]; signal?: AbortSignal;
  }) {
    const thread = await this.thread(input.userId, input.threadId);
    const user = await this.user(input.userId);
    if (thread.archived) throw new ConversationError(409, "Fork this archived conversation to continue it.");
    input.signal?.throwIfAborted();
    return this.services.turnCoordinator.accept({
      userId: user.tg_id, threadId: thread.id, locale: user.lang,
      chatId: input.source.kind === "telegram" ? input.source.chatId : user.tg_id,
      messageThreadId: thread.topic_id, kind: input.kind, content: input.content, textPlain: input.text,
      sources: input.source.kind === "telegram" ? input.source.updates : [],
      webRequestId: input.source.kind === "web" ? input.source.requestId : undefined,
      attachments: input.attachments, signal: input.signal,
    });
  }

  async stop(userId: number, threadId: ThreadRow["id"]) {
    await this.thread(userId, threadId);
    const incoming = this.services.cancelIncoming?.(threadId) ?? false;
    const turn = await this.services.turnCoordinator.cancelActive(threadId);
    return incoming || turn;
  }

  async fork(input: { userId: number; threadId: ThreadRow["id"]; origin: ThreadRow["origin"]; messageId?: number; link?: ConversationLink }) {
    const thread = await this.thread(input.userId, input.threadId);
    const user = await this.user(input.userId);
    return this.services.turnCoordinator.withThreadBarrier(thread.id, "fork", async (snapshotId, signal) => {
      const point = input.messageId ?? snapshotId;
      const chain = await this.services.repos.threads.chain(thread);
      const visible = point === null || point === 0 ? undefined
        : (await this.services.repos.messages.listForThreadChain(chain, point)).find(message => message.id === point);
      if (point !== null && point !== 0 && !visible) throw new ConversationError(404, "Message not found.");
      if (input.messageId !== undefined && !visible?.pi_entry_id) {
        throw new ConversationError(409, "This message has no saved model checkpoint. Fork the whole chat or choose an earlier completed reply.");
      }
      signal.throwIfAborted();
      const created = await this.create({ userId: user.tg_id, title: Array.from(`Fork: ${thread.title}`).slice(0, 128).join(""),
        origin: input.origin, link: input.link, parent: { threadId: thread.id, messageId: point } });
      try {
        signal.throwIfAborted();
        await this.services.pi.fork(thread, created, user, visible?.pi_entry_id, signal);
        signal.throwIfAborted();
        if (point !== null && point > 0) await this.services.repos.threadReads.markRead(user.tg_id, created.id, point);
        return created;
      } catch (error) {
        await this.services.repos.threads.archive(created.id);
        if (created.topic_id !== null) await input.link?.remove(user.tg_id, created.topic_id).catch(() => undefined);
        throw error;
      }
    });
  }

  async compact(userId: number, threadId: ThreadRow["id"]): Promise<CompactionRun> {
    const thread = await this.thread(userId, threadId);
    const user = await this.user(userId);
    if (thread.archived) throw new ConversationError(409, "Fork this archived conversation to continue it.");
    const existing = this.compactions.get(threadId);
    if (existing) return existing;
    const starting = this.startCompaction(thread, user);
    this.compactions.set(threadId, starting);
    try { return await starting; }
    catch (error) { this.compactions.delete(threadId); throw error; }
  }

  private async startCompaction(thread: ThreadRow, user: UserRow): Promise<CompactionRun> {
    const now = Date.now();
    const action: CompactionAction = { kind: "compaction", status: "queued", requestedAt: now, updatedAt: now };
    const message = await this.services.repos.messages.insert({ threadId: thread.id, role: "system", kind: "system",
      content: { action }, textPlain: compactionDescription(action, user.lang).title });
    const completion = this.performCompaction(thread, user, message.id, action).finally(() => this.compactions.delete(thread.id));
    void completion.catch(error => this.services.logger.warn("context compaction did not complete", { threadId: thread.id, error: String(error) }));
    return { messageId: message.id, completion };
  }

  private async performCompaction(thread: ThreadRow, user: UserRow, messageId: number, initial: CompactionAction): Promise<number> {
    let action = initial;
    let writes = Promise.resolve();
    let operationSignal: AbortSignal | undefined;
    const save = (next: CompactionAction) => {
      action = next;
      const description = compactionDescription(next, user.lang);
      writes = writes.catch(() => undefined).then(() => this.services.repos.messages.setDeliveryContent({ messageId,
        content: { action: next }, textPlain: [description.title, description.detail].filter(Boolean).join(". "), tgMessageId: null }));
      return writes;
    };
    const heartbeat = setInterval(() => {
      if (action.status === "queued" || action.status === "running") void save({ ...action, updatedAt: Date.now() })
        .catch(error => this.services.logger.warn("compaction progress could not be saved", { messageId, error: String(error) }));
    }, 10_000);
    heartbeat.unref();
    try {
      return await this.services.turnCoordinator.withThreadBarrier(thread.id, "compact", async (_snapshot, signal) => {
        operationSignal = signal;
        await this.user(user.tg_id);
        const startedAt = Date.now();
        await save({ kind: "compaction", status: "running", requestedAt: initial.requestedAt, startedAt, updatedAt: startedAt });
        const count = await this.services.pi.compact(thread, user, signal);
        signal.throwIfAborted();
        const finishedAt = Date.now();
        await save({ kind: "compaction", status: "succeeded", requestedAt: initial.requestedAt,
          startedAt, finishedAt, updatedAt: finishedAt, messagesCompacted: count });
        return count;
      });
    } catch (error) {
      const finishedAt = Date.now();
      await save({ kind: "compaction", status: "failed", requestedAt: initial.requestedAt,
        startedAt: action.status === "queued" ? null : action.startedAt, finishedAt, updatedAt: finishedAt,
        reason: error instanceof CompactionGuardError ? error.reason : operationSignal?.aborted ? "interrupted" : "failed",
        retryAt: error instanceof CompactionGuardError ? error.retryAt : null });
      throw error;
    } finally { clearInterval(heartbeat); }
  }

  async settings(userId: number) {
    const user = await this.user(userId);
    return { language: user.lang, timeZone: user.tz_name, timezoneOffsetMinutes: userOffsetMinutes(user),
      streaming: Boolean(user.stream_mode), memoryEnabled: Boolean(user.memory_enabled) };
  }

  async updateSettings(userId: number, patch: ConversationSettingsPatch) {
    const parsed = settingsSchema.safeParse(patch);
    if (!parsed.success) throw new ConversationError(400, "Invalid settings.");
    await this.user(userId);
    const value = parsed.data;
    const zone = value.timeZone ? canonicalTimeZone(value.timeZone) : null;
    if (value.timeZone && !zone) throw new ConversationError(400, "Unknown time zone.");
    await this.services.db.db.execute(sql`
      update users set lang = coalesce(${value.language ?? null}, lang),
        tz_name = case when ${value.timeZone !== undefined ? 1 : 0} = 1 then ${zone} else tz_name end,
        tz_offset_min = case when ${value.timeZone !== undefined ? 1 : 0} = 1 then ${zone ? zoneOffsetMinutes(zone) : null} else tz_offset_min end,
        stream_mode = coalesce(${value.streaming === undefined ? null : Number(value.streaming)}, stream_mode),
        memory_enabled = coalesce(${value.memoryEnabled === undefined ? null : Number(value.memoryEnabled)}, memory_enabled)
      where tg_id = ${userId}
    `);
    return this.settings(userId);
  }
}
