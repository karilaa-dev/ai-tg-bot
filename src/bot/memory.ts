import { InlineKeyboard } from "grammy";
import { readUserMemories } from "../memory/view.js";
import type { BotContext } from "./context.js";
import { editOrReply, replyWithThreadFallback, threadExtra } from "./replies.js";

export async function showMemories(ctx: BotContext, page: number, edit = false): Promise<void> {
  if (!ctx.user) return;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * 10)) {
    await replyWithThreadFallback(ctx, ctx.t("memory-usage"), threadExtra(ctx.thread));
    return;
  }
  const memories = await readUserMemories(ctx.services.db.db, ctx.user.tg_id, (page - 1) * 10, 10);
  const keyboard = new InlineKeyboard();
  let text: string;
  if (!memories.total) text = ctx.t("memory-empty");
  else if (!memories.items.length) {
    text = ctx.t("memory-page-missing");
    keyboard.text(ctx.t("memory-first"), "memory:page:1");
  } else {
    text = [ctx.t("memory-heading", { page, pages: Math.ceil(memories.total / 10), total: memories.total }),
      ...memories.items.map(memory => `#${memory.id} · ${memory.date}\n${memory.text}`)].join("\n\n");
    if (page > 1) keyboard.text(ctx.t("memory-previous"), `memory:page:${page - 1}`);
    if (memories.nextOffset !== null) keyboard.text(ctx.t("memory-next"), `memory:page:${page + 1}`);
  }
  const extra = { reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  if (edit) await editOrReply(ctx, text, extra);
  else await replyWithThreadFallback(ctx, text, { ...threadExtra(ctx.thread), ...extra });
}
