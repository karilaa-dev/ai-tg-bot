import type { MessageKind } from "../db/types.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback, threadExtra } from "./replies.js";
import type { TelegramTurnSource } from "../db/repos/turnRuns.js";
import type { DurableTurnAttachment } from "../db/repos/turnRuns.js";
import { throwIfAborted } from "../files/cancel.js";

/**
 * Accept Telegram input as a durable turn. Transient failures are retried with
 * the same update IDs, so a commit whose reply was lost resolves to the same
 * turn. Feedback sent after acceptance never triggers another acceptance.
 */
export async function handleUserText(
  ctx: BotContext,
  text: string,
  options: {
    userMessageKind?: MessageKind;
    userMessageContent?: unknown;
    attachments?: DurableTurnAttachment[];
    sources?: TelegramTurnSource[];
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  const startedAt = Date.now();
  const kind = options.userMessageKind ?? "text";
  const content = options.userMessageContent ?? { text };
  ctx.services.logger.info("turn durable acceptance starting", ctxLogMeta(ctx, {
    kind: options.userMessageKind ?? "text",
    textChars: text.length,
  }));
  throwIfAborted(options.signal);
  const input = {
    userId: ctx.user.tg_id,
    threadId: ctx.thread.id,
    kind,
    content,
    text,
    source: { kind: "telegram" as const, chatId: ctx.chat.id, updates: options.sources ?? [telegramTurnSource(ctx, { kind, content, textPlain: text })] },
    attachments: options.attachments,
  };
  const updateIds = input.source.updates.map((source) => source.updateId);
  const outcome = await ctx.services.routerState.intake.accept(
    ctx.thread.id,
    `telegram updates ${updateIds.join(",")}`,
    (signal) => ctx.services.conversations.accept({ ...input, signal }).catch((error: unknown) => {
      ctx.services.logger.warn("turn durable acceptance attempt failed", ctxLogMeta(ctx, { updateIds, err: String(error) }));
      throw error;
    }),
    options.signal,
  );
  if (outcome.status === "cancelled") {
    ctx.services.logger.info("turn durable acceptance cancelled", ctxLogMeta(ctx, { updateIds }));
    throwIfAborted(options.signal);
    return;
  }
  if (outcome.status === "failed") {
    ctx.services.logger.error("turn durable acceptance failed", ctxLogMeta(ctx, {
      updateIds, attempts: outcome.attempts, err: String(outcome.error),
    }));
    // The last attempt may still have committed, so the notice must not claim the message was lost.
    await replyWithThreadFallback(ctx, ctx.t("intake-failed"), threadExtra(ctx.thread)).catch((error: unknown) => {
      ctx.services.logger.warn("acceptance failure notice could not be sent", ctxLogMeta(ctx, { err: String(error) }));
    });
    return;
  }
  const accepted = outcome.value;
  if (accepted.created && accepted.queuedBehind) {
    await replyWithThreadFallback(ctx, ctx.t("busy"), threadExtra(ctx.thread)).catch((error: unknown) => {
      ctx.services.logger.warn("queued turn acknowledgement could not be sent", ctxLogMeta(ctx, {
        turnRunId: accepted.turnRun.id, err: String(error),
      }));
    });
  }
  ctx.services.logger.info("turn durable acceptance finished", ctxLogMeta(ctx, {
    turnRunId: accepted.turnRun.id,
    kind: options.userMessageKind ?? "text",
    duplicate: !accepted.created || undefined,
    queuedBehind: accepted.queuedBehind || undefined,
    ms: Date.now() - startedAt,
  }));
}

export function telegramTurnSource(
  ctx: BotContext,
  payload?: TelegramTurnSource["payload"],
): TelegramTurnSource {
  return {
    updateId: ctx.update.update_id,
    messageId: ctx.message?.message_id ?? null,
    payload,
  };
}
