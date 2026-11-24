import type { BotContext, BotServices, PendingMediaGroup, PendingMediaGroupItem } from "./context.js";
import { ctxLogMeta } from "./logging.js";
import { handleUserText, telegramTurnSource } from "./turns.js";

const mediaGroupFlushMs = 250;
const textBurstFlushMs = 1_000;
const splitTextChunkMinChars = 3_000;
const maxCancelledMediaGroups = 1_024;

function mediaGroupKey(ctx: BotContext, groupId?: string): string | undefined {
  return groupId && ctx.chat && ctx.thread ? `${ctx.chat.id}:${ctx.thread.id}:${groupId}` : undefined;
}

export function isMediaGroupCancelled(ctx: BotContext, groupId?: string): boolean {
  const key = mediaGroupKey(ctx, groupId);
  return key !== undefined && ctx.services.routerState.cancelledMediaGroups.has(key);
}

export function cancelMediaGroup(ctx: BotContext, groupId?: string): void {
  const key = mediaGroupKey(ctx, groupId);
  if (!key) return;
  rememberCancelledMediaGroup(ctx, key);
}

function rememberCancelledMediaGroup(ctx: BotContext, key: string): void {
  takeMediaGroup(ctx, key);
  const cancelled = ctx.services.routerState.cancelledMediaGroups;
  cancelled.add(key);
  if (cancelled.size > maxCancelledMediaGroups) cancelled.delete(cancelled.values().next().value!);
}

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
  return setTimeout(() => startTextBurstFlush(ctx, key), textBurstFlushMs);
}

function startTextBurstFlush(ctx: BotContext, key: string): void {
  void ctx.services.routerState.intake.track("text burst", flushPendingTextBurst(ctx, key)).catch((err) => {
    ctx.services.logger.error("text burst flush failed", { err: String(err) });
  });
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
  const pending = takeTextBurst(ctx, key);
  if (!pending) return false;
  ctx.services.logger.info("pending text burst cancelled", ctxLogMeta(ctx, {
    parts: pending.texts.length,
  }));
  return true;
}

export function cancelPendingMediaGroupsForContext(ctx: BotContext): boolean {
  if (!ctx.chat || !ctx.thread) return false;
  let cancelled = false;
  for (const [key, pending] of ctx.services.routerState.pendingMediaGroups) {
    if (pending.ctx.chat?.id !== ctx.chat.id || pending.ctx.thread?.id !== ctx.thread.id) continue;
    rememberCancelledMediaGroup(ctx, key);
    cancelled = true;
  }
  return cancelled;
}

export function cancelPendingForThread(state: BotServices["routerState"], threadId: string): boolean {
  let cancelled = state.intake.cancel(threadId);
  for (const pending of state.pendingTextBursts.values()) {
    if (pending.ctx.thread?.id === threadId) cancelled = cancelPendingTextBurstForContext(pending.ctx) || cancelled;
  }
  for (const pending of state.pendingMediaGroups.values()) {
    if (pending.ctx.thread?.id === threadId) cancelled = cancelPendingMediaGroupsForContext(pending.ctx) || cancelled;
  }
  return cancelled;
}

function takeTextBurst(ctx: BotContext, key: string) {
  const bursts = ctx.services.routerState.pendingTextBursts;
  const pending = bursts.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    bursts.delete(key);
  }
  return pending;
}

async function flushPendingTextBurst(ctx: BotContext, key: string): Promise<void> {
  const pending = takeTextBurst(ctx, key);
  if (!pending) return;

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
  if (isMediaGroupCancelled(ctx, groupId)) return;
  const pendingMediaGroups = ctx.services.routerState.pendingMediaGroups;
  const key = `${ctx.chat.id}:${ctx.thread.id}:${groupId}`;
  const existing = pendingMediaGroups.get(key);
  if (existing) {
    clearMediaGroupTimer(existing);
    existing.ctx = ctx;
    existing.items.push({ ...item, source: mediaTurnSource(ctx, item) });
    ctx.services.logger.debug("media group item appended", ctxLogMeta(ctx, {
      groupId,
      items: existing.items.length,
    }));
    existing.collection = scheduleMediaGroupFlush(key, ctx, groupId);
    return;
  }

  const pending: PendingMediaGroup = {
    ctx,
    items: [{ ...item, source: mediaTurnSource(ctx, item) }],
    collection: scheduleMediaGroupFlush(key, ctx, groupId),
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
  clearMediaGroupTimer(pending);
  pending.collection = { phase: "held" };
  return () => {
    if (ctx.services.routerState.pendingMediaGroups.get(key) !== pending) return;
    clearMediaGroupTimer(pending);
    pending.collection = scheduleMediaGroupFlush(key, ctx, groupId);
  };
}

function clearMediaGroupTimer(pending: PendingMediaGroup): void {
  if (pending.collection.phase === "collecting") clearTimeout(pending.collection.timer);
}

function takeMediaGroup(ctx: BotContext, key: string): PendingMediaGroup | undefined {
  const groups = ctx.services.routerState.pendingMediaGroups;
  const pending = groups.get(key);
  if (pending) {
    clearMediaGroupTimer(pending);
    groups.delete(key);
  }
  return pending;
}

function scheduleMediaGroupFlush(key: string, ctx: BotContext, groupId: string): PendingMediaGroup["collection"] {
  return { phase: "collecting", timer: setTimeout(() => startMediaGroupFlush(ctx, key, groupId), mediaGroupFlushMs) };
}

function startMediaGroupFlush(ctx: BotContext, key: string, groupId?: string): void {
  void ctx.services.routerState.intake.track("media group", flushMediaGroup(ctx, key)).catch((err) => {
    ctx.services.logger.error("media group flush failed", { err: String(err), groupId });
  });
}

/**
 * Send batches that are still collecting and wait for Telegram input to be
 * accepted before shutdown closes the coordinator. Input that is still not
 * accepted at the deadline is cancelled, logged and returned.
 */
export async function drainTelegramIntake(services: BotServices, timeoutMs = 10_000): Promise<string[]> {
  const state = services.routerState;
  const residue = await state.intake.drain(timeoutMs, () => {
    for (const [key, pending] of state.pendingTextBursts) {
      startTextBurstFlush(pending.ctx, key);
    }
    for (const [key, pending] of state.pendingMediaGroups) {
      startMediaGroupFlush(pending.ctx, key);
    }
  });
  if (residue.length) {
    for (const job of state.activeFileJobs.values()) job.cancel();
    services.logger.error("Telegram input was not accepted before shutdown", { pending: residue });
  }
  return residue;
}

async function flushMediaGroup(flushCtx: BotContext, key: string): Promise<void> {
  const pending = takeMediaGroup(flushCtx, key);
  if (!pending) return;

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
