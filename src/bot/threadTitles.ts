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
}

export class ThreadTitleCoordinator {
  private readonly jobs = new Map<number, Promise<void>>();
  private readonly titleUpdates = new Map<number, Promise<void>>();
  private readonly telegramTitles = new Map<string, string>();

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

  observeTelegramTitle(chatId: number, topicId: number, title: string): void {
    const key = `${chatId}:${topicId}`;
    this.telegramTitles.delete(key);
    this.telegramTitles.set(key, title);
    if (this.telegramTitles.size > MAX_REMEMBERED_TOPIC_TITLES) {
      this.telegramTitles.delete(this.telegramTitles.keys().next().value!);
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

  async syncActivity(input: ThreadTitleScheduleInput): Promise<void> {
    const previous = this.titleUpdates.get(input.threadId) ?? Promise.resolve();
    const update = previous.then(() => this.syncTelegramTitle(input)).catch((error) => {
      this.input.logger.warn("thread title could not be synchronized to Telegram", {
        threadId: input.threadId, error: String(error),
      });
    });
    this.titleUpdates.set(input.threadId, update);
    await update;
    if (this.titleUpdates.get(input.threadId) === update) this.titleUpdates.delete(input.threadId);
  }

  private async syncTelegramTitle(input: ThreadTitleScheduleInput): Promise<void> {
    const thread = await this.input.repos.threads.get(input.threadId);
    if (!isEligibleTopic(thread)) return;
    const working = await this.input.repos.turnRuns.hasUnfinished(thread.id);
    const name = working ? `⏳ ${Array.from(thread.title).slice(0, 126).join("")}` : thread.title;
    const key = `${input.chatId}:${thread.topic_id}`;
    if (this.telegramTitles.get(key) !== name) {
      // Acceptance and execution can request the same title. Telegram may
      // create a service message even when the requested name is unchanged.
      this.telegramTitles.delete(key);
      try {
        await input.api.raw.editForumTopic({
          chat_id: input.chatId,
          message_thread_id: thread.topic_id!,
          name,
        }, AbortSignal.timeout(5_000) as Parameters<Api["raw"]["editForumTopic"]>[1]);
      } catch (error) {
        if (!isTopicNotModified(error)) throw error;
      }
      this.observeTelegramTitle(input.chatId, thread.topic_id!, name);
    }
    if (thread.title_source === "generated") {
      await this.input.repos.threads.markTopicTitleSynced(thread.id, thread.title);
    }
  }
}

function isEligibleTopic(thread: ThreadRow | undefined): thread is ThreadRow {
  return Boolean(thread && thread.topic_id !== null && thread.topic_id !== 1);
}

function isTopicNotModified(error: unknown): boolean {
  const message = error instanceof GrammyError ? error.description : String(error);
  return /TOPIC_NOT_MODIFIED|topic is not modified/i.test(message);
}
