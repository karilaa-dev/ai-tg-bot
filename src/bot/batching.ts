import type { BotContext, PendingMediaGroup, PendingMediaGroupItem } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { handleUserText, telegramTurnSource } from "./turns.js";

const mediaGroupFlushMs = 250;
const textBurstFlushMs = 1_000;
const splitTextChunkMinChars = 3_000;

export async function enqueueUserText(ctx: BotContext, text: string): Promise<void> {
  const key = textBurstKey(ctx);
  if (!key) {
    ctx.services.logger.debug("text burst unavailable; dispatching immediately", ctxLogMeta(ctx, { chars: text.length }));
    await handleUserText(ctx, text);
    return;
  }

  const pendingTextBursts = ctx.services.routerState.pendingTextBursts;
  const existing = pendingTextBursts.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.ctx = ctx;
    existing.texts.push(text);
    existing.sources.push(textTurnSource(ctx, text));
    existing.timer = scheduleTextBurstFlush(key, ctx);
    ctx.services.logger.debug("text burst appended", ctxLogMeta(ctx, {
      parts: existing.texts.length,
      chars: existing.texts.reduce((sum, part) => sum + part.length, 0),
    }));
    return;
  }

  if (text.length < splitTextChunkMinChars) {
    ctx.services.logger.debug("text below burst threshold; dispatching immediately", ctxLogMeta(ctx, { chars: text.length }));
    await handleUserText(ctx, text);
    return;
  }

  pendingTextBursts.set(key, {
    ctx,
    texts: [text],
    sources: [textTurnSource(ctx, text)],
    timer: scheduleTextBurstFlush(key, ctx),
  });
  ctx.services.logger.debug("text burst queued", ctxLogMeta(ctx, { chars: text.length }));
}

function scheduleTextBurstFlush(key: string, ctx: BotContext): NodeJS.Timeout {
  return setTimeout(() => {
    void flushPendingTextBurst(ctx, key).catch((err) => {
      ctx.services.logger.error("text burst flush failed", { err: String(err) });
    });
  }, textBurstFlushMs);
}

export async function flushPendingTextBurstForContext(ctx: BotContext): Promise<void> {
  const key = textBurstKey(ctx);
  if (!key) return;
  ctx.services.logger.debug("flushing text burst before non-text update", ctxLogMeta(ctx));
  await flushPendingTextBurst(ctx, key);
}

export function cancelPendingTextBurstForContext(ctx: BotContext): boolean {
  const key = textBurstKey(ctx);
  if (!key) return false;
  const pending = ctx.services.routerState.pendingTextBursts.get(key);
  if (!pending) return false;
  ctx.services.routerState.pendingTextBursts.delete(key);
  clearTimeout(pending.timer);
  ctx.services.logger.info("pending text burst cancelled", ctxLogMeta(ctx, {
    parts: pending.texts.length,
  }));
  return true;
}

async function flushPendingTextBurst(ctx: BotContext, key: string): Promise<void> {
  const pendingTextBursts = ctx.services.routerState.pendingTextBursts;
  const pending = pendingTextBursts.get(key);
  if (!pending) return;
  pendingTextBursts.delete(key);
  clearTimeout(pending.timer);

  const text = pending.texts.join("\n\n");
  if (!text) return;
  pending.ctx.services.logger.info("text burst flushed", ctxLogMeta(pending.ctx, {
    parts: pending.texts.length,
    chars: text.length,
  }));
  await handleUserText(pending.ctx, text, { sources: pending.sources });
}

function textBurstKey(ctx: BotContext): string | undefined {
  if (!ctx.chat || !ctx.user || !ctx.thread) return undefined;
  return `${ctx.chat.id}:${ctx.user.tg_id}:${ctx.thread.id}`;
}

export function isPlainUserText(ctx: BotContext): boolean {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  return typeof text === "string" && !text.startsWith("/");
}

export function enqueueMediaGroup(ctx: BotContext, groupId: string, item: Omit<PendingMediaGroupItem, "source">): void {
  if (!ctx.chat || !ctx.thread) return;
  const pendingMediaGroups = ctx.services.routerState.pendingMediaGroups;
  const key = `${ctx.chat.id}:${ctx.thread.id}:${groupId}`;
  const existing = pendingMediaGroups.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.ctx = ctx;
    existing.items.push({ ...item, source: mediaTurnSource(ctx, item) });
    ctx.services.logger.debug("media group item appended", ctxLogMeta(ctx, {
      groupId,
      items: existing.items.length,
    }));
    existing.timer = scheduleMediaGroupFlush(key, ctx, groupId);
    return;
  }

  const pending: PendingMediaGroup = {
    ctx,
    items: [{ ...item, source: mediaTurnSource(ctx, item) }],
    timer: scheduleMediaGroupFlush(key, ctx, groupId),
  };
  pendingMediaGroups.set(key, pending);
  ctx.services.logger.debug("media group queued", ctxLogMeta(ctx, { groupId, items: 1 }));
}

// Keep earlier album items queued while the next attachment downloads or transcribes.
export function holdPendingMediaGroup(ctx: BotContext, groupId?: string): () => void {
  if (!groupId || !ctx.chat || !ctx.thread) return () => {};
  const key = `${ctx.chat.id}:${ctx.thread.id}:${groupId}`;
  const pending = ctx.services.routerState.pendingMediaGroups.get(key);
  if (!pending) return () => {};
  clearTimeout(pending.timer);
  return () => {
    if (ctx.services.routerState.pendingMediaGroups.get(key) !== pending) return;
    clearTimeout(pending.timer);
    pending.timer = scheduleMediaGroupFlush(key, ctx, groupId);
  };
}

function scheduleMediaGroupFlush(key: string, ctx: BotContext, groupId: string): NodeJS.Timeout {
  return setTimeout(() => {
    void flushMediaGroup(ctx, key).catch((err) => {
      ctx.services.logger.error("media group flush failed", { err: String(err), groupId });
    });
  }, mediaGroupFlushMs);
}

async function flushMediaGroup(flushCtx: BotContext, key: string): Promise<void> {
  const pendingMediaGroups = flushCtx.services.routerState.pendingMediaGroups;
  const pending = pendingMediaGroups.get(key);
  if (!pending) return;
  pendingMediaGroups.delete(key);

  const { ctx, items } = pending;
  if (!ctx.user || !ctx.thread || !ctx.chat || items.length === 0) return;
  ctx.services.logger.info("media group flushing", ctxLogMeta(ctx, {
    items: items.length,
    imageItems: items.filter((item) => item.file.type === "image").length,
  }));

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
    sources: items.map((item) => item.source),
    attachments: items.map((item) => ({
      fileId: item.file.id,
      displayName: item.file.name,
      caption: item.caption ?? null,
      telegramMessageId: item.source.messageId,
    })),
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

function textTurnSource(ctx: BotContext, text: string) {
  return telegramTurnSource(ctx, {
    kind: "text",
    content: { text },
    textPlain: text,
  });
}

function mediaTurnSource(
  ctx: BotContext,
  item: Omit<PendingMediaGroupItem, "source">,
) {
  const captions = uniqueNonEmpty([item.caption]);
  const text = [...captions, item.card].join("\n\n");
  return telegramTurnSource(ctx, {
    kind: item.file.type === "image" ? "image" : "file",
    textPlain: text,
    content: {
      text,
      captions,
      files: [item.file],
    },
  });
}
