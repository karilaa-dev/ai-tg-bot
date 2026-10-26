import type { Api } from "grammy";
import type { TurnFrontend } from "../application/turnFrontend.js";
import type { TurnRunner } from "../ai/types.js";
import { TurnActivityCoordinator } from "../ai/turnActivity.js";
import type { Repos } from "../db/repos/index.js";
import type { FileResolver } from "../files/resolver.js";
import type { Logger } from "../logger.js";
import { quietTelegramApi, mirrorWebMessage, replyToWebMessage } from "../web/telegram-mirror.js";
import { asRecord } from "../util/records.js";

export function telegramTurnFrontend(options: {
  api: Api; repos: Repos; logger: Logger; fileResolver: FileResolver; turnRunner: TurnRunner;
  syncThreadActivity?: ConstructorParameters<typeof TurnActivityCoordinator>[0]["syncThreadActivity"];
}): TurnFrontend {
  return {
    activity: new TurnActivityCoordinator(options),
    async run(input, { run, message }) {
      const { thread } = input;
      const api = run.origin === "web" ? quietTelegramApi(options.api) : options.api;
      if (run.origin === "web") {
        try {
          await mirrorWebMessage({ api, run, message, title: thread.title, repos: options.repos, resolver: options.fileResolver, signal: input.signal ?? new AbortController().signal });
        } catch (error) {
          input.signal?.throwIfAborted();
          options.logger.warn("web message Telegram mirror failed; continuing assistant turn", {
            turnRunId: run.id, threadId: run.thread_id, error: String(error),
          });
          const current = await options.repos.messages.get(message.id);
          await options.repos.messages.setDeliveryContent({ messageId: message.id,
            content: { ...asRecord(input.userMessageContent), telegramSyncFailed: true }, textPlain: message.text_plain,
            tgMessageId: current?.tg_message_id ?? null });
        }
        const mirrored = await options.repos.messages.get(message.id);
        if (mirrored?.tg_message_id) replyToWebMessage(api, run.chat_id, mirrored.tg_message_id);
      }
      await options.turnRunner({ ...input, api, chatId: run.chat_id, messageThreadId: run.message_thread_id ?? undefined });
    },
  };
}
