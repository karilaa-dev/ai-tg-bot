import { GrammyError, type Api } from "grammy";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import { sanitizeThreadTitle } from "../pi/threadTitle.js";

const MAX_TITLE_ATTEMPTS = 3;

export interface ThreadTitleScheduleInput {
  api: Api;
  chatId: number;
  threadId: number;
}

export class ThreadTitleCoordinator {
  private readonly jobs = new Map<number, Promise<void>>();

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
  }

  private async run(input: ThreadTitleScheduleInput): Promise<void> {
    const thread = await this.input.repos.threads.get(input.threadId);
    if (!isEligibleTopic(thread)) return;

    if (thread.title_source === "generated") {
      if (!thread.topic_title_synced) await this.syncTelegramTitle(input, thread);
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
    await this.syncTelegramTitle(input, updated);
  }

  private async syncTelegramTitle(input: ThreadTitleScheduleInput, thread: ThreadRow): Promise<void> {
    if (thread.topic_id === null) return;

    const current = await this.input.repos.threads.get(thread.id);
    if (!current || current.title_source !== "generated" || current.title !== thread.title) return;
    try {
      await input.api.raw.editForumTopic({
        chat_id: input.chatId,
        message_thread_id: thread.topic_id,
        name: thread.title,
      });
    } catch (error) {
      if (!isTopicNotModified(error)) {
        this.input.logger.warn("generated thread title could not be synchronized to Telegram", {
          threadId: thread.id,
          topicId: thread.topic_id,
          error: String(error),
        });
        return;
      }
    }
    const synced = await this.input.repos.threads.markTopicTitleSynced(thread.id, thread.title);
    if (!synced) return;
    this.input.logger.info("generated thread title synchronized to Telegram", {
      threadId: thread.id,
      topicId: thread.topic_id,
    });
  }
}

function isEligibleTopic(thread: ThreadRow | undefined): thread is ThreadRow {
  return Boolean(thread && thread.topic_id !== null && thread.topic_id !== 1);
}

function isTopicNotModified(error: unknown): boolean {
  const message = error instanceof GrammyError ? error.description : String(error);
  return /TOPIC_NOT_MODIFIED|topic is not modified/i.test(message);
}
