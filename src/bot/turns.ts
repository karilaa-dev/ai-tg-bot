import type { MessageKind, MessageRow } from "../db/types.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { replyWithThreadFallback, threadExtra } from "./replies.js";

export async function handleUserText(
  ctx: BotContext,
  text: string,
  options: {
    userMessageKind?: MessageKind;
    userMessageContent?: unknown;
    onUserMessagePersisted?: (message: MessageRow) => Promise<void>;
  } = {},
): Promise<void> {
  if (!ctx.user || !ctx.thread || !ctx.chat) return;
  const busyThreads = ctx.services.routerState.busyThreads;
  if (busyThreads.has(ctx.thread.id)) {
    ctx.services.logger.info("turn queued while thread busy", ctxLogMeta(ctx, {
      kind: options.userMessageKind ?? "text",
      textChars: text.length,
    }));
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
  const startedAt = Date.now();
  ctx.services.logger.info("turn dispatch starting", ctxLogMeta(ctx, {
    kind: options.userMessageKind ?? "text",
    textChars: text.length,
  }));
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
      resolveFile: (file, signal) => ctx.services.fileResolver.resolveFile(file, signal),
      pi: ctx.services.pi,
      t: ctx.t,
    });
    ctx.services.threadTitles.schedule({
      api: ctx.api,
      chatId: ctx.chat.id,
      threadId: ctx.thread.id,
    });
  } finally {
    busyThreads.delete(ctx.thread.id);
    ctx.services.logger.info("turn dispatch finished", ctxLogMeta(ctx, {
      kind: options.userMessageKind ?? "text",
      ms: Date.now() - startedAt,
    }));
  }
}
