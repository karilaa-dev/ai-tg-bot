import { GrammyError, type Api } from "grammy";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import { sanitizeThreadTitle } from "../pi/threadTitle.js";

const MAX_TITLE_ATTEMPTS = 3;
const MAX_REMEMBERED_TOPIC_TITLES = 1_000;

interface ThreadTitleScheduleInput {
  api: Api;
  chatId: number;
  threadId: number;
  signal?: AbortSignal;
}

export class ThreadTitleCoordinator {
  private readonly jobs = new Map<number, Promise<void>>();
  private readonly titleUpdates = new Map<number, Promise<boolean>>();
  private readonly requestedActivityTitles = new Map<string, Set<string>>();

  constructor(private readonly input: {
    repos: Repos;
    pi: PiRuntimeService;
    logger: Logger;
  }) {}

  schedule(input: ThreadTitleScheduleInput): void {
    if (this.jobs.has(input.threadId)) {
      this.input.logger.debug("thread title job already in flight", { threadId: input.threadId });
      return;
    }
    let job: Promise<void>;
    job = this.run(input)
      .catch((error) => {
        this.input.logger.warn("thread title background job failed", {
          threadId: input.threadId,
          error: String(error),
        });
      })
      .finally(() => {
        if (this.jobs.get(input.threadId) === job) this.jobs.delete(input.threadId);
      });
    this.jobs.set(input.threadId, job);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.jobs.values()]);
    await Promise.all([...this.titleUpdates.values()]);
  }

  async observeTelegramTitle(chatId: number, topicId: number, title: string): Promise<void> {
    await this.input.repos.threads.recordTelegramTitle(chatId, topicId, title);
  }

  async isRequestedActivityTitle(chatId: number, topicId: number, title: string): Promise<boolean> {
    return Boolean(this.requestedActivityTitles.get(`${chatId}:${topicId}`)?.has(title)
      || (await this.input.repos.threads.telegramTitle(chatId, topicId))?.requested_activity_title === title);
  }

  private rememberActivityTitle(chatId: number, topicId: number, title: string): void {
    const key = `${chatId}:${topicId}`;
    const titles = this.requestedActivityTitles.get(key) ?? new Set<string>();
    titles.add(title);
    if (titles.size > 16) titles.delete(titles.values().next().value!);
    this.requestedActivityTitles.delete(key);
    this.requestedActivityTitles.set(key, titles);
    if (this.requestedActivityTitles.size > MAX_REMEMBERED_TOPIC_TITLES) {
      this.requestedActivityTitles.delete(this.requestedActivityTitles.keys().next().value!);
    }
  }

  private async run(input: ThreadTitleScheduleInput): Promise<void> {
    const thread = await this.input.repos.threads.get(input.threadId);
    if (!isEligibleTopic(thread)) return;

    if (thread.title_source === "generated") {
      if (!thread.topic_title_synced) await this.syncActivity(input);
      return;
    }
    if (thread.title_source !== "placeholder" || thread.title_attempts >= MAX_TITLE_ATTEMPTS) return;

    const messages = await this.input.repos.messages.listThread(thread.id);
    const userMessage = messages.find((message) => message.role === "user" && message.text_plain.trim());
    const assistantMessage = userMessage
      ? messages.find((message) => message.id > userMessage.id && message.role === "assistant" && message.text_plain.trim())
      : undefined;
    if (!userMessage || !assistantMessage) return;

    const claimed = await this.input.repos.threads.claimTitleGeneration(thread.id, MAX_TITLE_ATTEMPTS);
    if (!claimed) return;
    this.input.logger.info("thread title generation starting", {
      threadId: thread.id,
      topicId: thread.topic_id,
      attempt: claimed.title_attempts,
    });

    let rawTitle: string;
    try {
      rawTitle = await this.input.pi.generateThreadTitle({
        userText: userMessage.text_plain,
        assistantText: assistantMessage.text_plain,
      });
    } catch (error) {
      this.input.logger.warn("thread title generation failed", {
        threadId: thread.id,
        topicId: thread.topic_id,
        attempt: claimed.title_attempts,
        error: String(error),
      });
      return;
    }

    const title = sanitizeThreadTitle(rawTitle);
    if (!title) {
      this.input.logger.warn("thread title generation returned no usable title", {
        threadId: thread.id,
        topicId: thread.topic_id,
        attempt: claimed.title_attempts,
        outputChars: rawTitle.length,
      });
      return;
    }

    const updated = await this.input.repos.threads.setGeneratedTitleIfPlaceholder(thread.id, title);
    if (!updated) {
      this.input.logger.info("thread title generation discarded after title changed", {
        threadId: thread.id,
        topicId: thread.topic_id,
      });
      return;
    }
    this.input.logger.info("thread title generated", {
      threadId: thread.id,
      topicId: thread.topic_id,
      titleChars: Array.from(title).length,
    });
    await this.syncActivity(input);
  }

  async syncActivity(input: ThreadTitleScheduleInput): Promise<boolean> {
    const previous = this.titleUpdates.get(input.threadId) ?? Promise.resolve(true);
    const update = previous.then(() => this.syncTelegramTitle(input)).catch((error) => {
      this.input.logger.warn("thread title could not be synchronized to Telegram", {
        threadId: input.threadId, error: String(error),
      });
      if (error instanceof GrammyError && (error.error_code === 403
        || (error.error_code === 400 && /topic.*not found|topic_id_invalid|message thread not found/i.test(error.description)))) return true;
      return false;
    });
    this.titleUpdates.set(input.threadId, update);
    const synced = await update;
    if (this.titleUpdates.get(input.threadId) === update) this.titleUpdates.delete(input.threadId);
    return synced;
  }

  private async syncTelegramTitle(input: ThreadTitleScheduleInput): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      input.signal?.throwIfAborted();
      const thread = await this.input.repos.threads.get(input.threadId);
      if (!isEligibleTopic(thread)) return true;
      const working = await this.input.repos.turnRuns.hasUnfinished(thread.id);
      const name = activityTitle(thread.title, working);
      // A manual rename can arrive during either the database read or the
      // Telegram request. Check before sending and reconcile again afterward.
      const beforeSend = await this.input.repos.threads.get(thread.id);
      if (beforeSend?.title !== thread.title) continue;
      const known = await this.input.repos.threads.telegramTitle(input.chatId, thread.topic_id!);
      if (known?.name !== name) {
        await this.input.repos.threads.recordTelegramTitle(input.chatId, thread.topic_id!, null);
        if (working) {
          this.rememberActivityTitle(input.chatId, thread.topic_id!, name);
          await this.input.repos.threads.recordActivityTitleRequest(input.chatId, thread.topic_id!, name);
        }
        try {
          await input.api.raw.editForumTopic({
            chat_id: input.chatId,
            message_thread_id: thread.topic_id!,
            name,
          }, AbortSignal.any([AbortSignal.timeout(5_000), ...(input.signal ? [input.signal] : [])]) as Parameters<Api["raw"]["editForumTopic"]>[1]);
        } catch (error) {
          if (!isTopicNotModified(error)) throw error;
        }
        await this.observeTelegramTitle(input.chatId, thread.topic_id!, name);
      }
      const latest = await this.input.repos.threads.get(thread.id);
      const stillWorking = await this.input.repos.turnRuns.hasUnfinished(thread.id);
      if (latest && activityTitle(latest.title, stillWorking) !== name) continue;
      if (thread.title_source === "generated") {
        await this.input.repos.threads.markTopicTitleSynced(thread.id, thread.title);
      }
      return true;
    }
    return false;
  }
}

function isEligibleTopic(thread: ThreadRow | undefined): thread is ThreadRow {
  return Boolean(thread && thread.topic_id !== null && thread.topic_id !== 1);
}

function isTopicNotModified(error: unknown): boolean {
  const message = error instanceof GrammyError ? error.description : String(error);
  return /TOPIC_NOT_MODIFIED|topic is not modified/i.test(message);
}

function activityTitle(title: string, working: boolean): string {
  return working ? `⏳ ${Array.from(title).slice(0, 126).join("")}` : title;
}
