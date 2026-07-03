import type { Bot } from "grammy";
import { format } from "date-fns";
import type { Repos } from "../db/repos/index.js";
import { escapeHtml } from "../util/text.js";
import type { BotContext } from "./context.js";
import { ctxLogMeta, logCallback, logCommand } from "./logging.js";
import { editOrReply, replyWithThreadFallback, threadExtra } from "./replies.js";
import { inviteDraftKeyboard, invitesListKeyboard, inviteUseOptions, type InviteExpiry } from "./keyboards.js";
import { isAdmin } from "./auth.js";

export function registerInviteHandlers(bot: Bot<BotContext>): void {
  bot.command("invite", async (ctx) => {
    logCommand(ctx, "invite");
    if (!isAdmin(ctx)) return;
    await replyWithThreadFallback(ctx, inviteDraftText(ctx, 1, "30d"), {
      ...threadExtra(ctx.thread),
      reply_markup: inviteDraftKeyboard(ctx.t, 1, "30d"),
    });
  });
  bot.command("invites", async (ctx) => {
    logCommand(ctx, "invites");
    if (!isAdmin(ctx)) return;
    const invites = await ctx.services.repos.invites.list();
    ctx.services.logger.debug("invites listed", ctxLogMeta(ctx, { invites: invites.length }));
    if (!invites.length) {
      await replyWithThreadFallback(ctx, ctx.t("invites-empty"), threadExtra(ctx.thread));
      return;
    }
    await replyWithThreadFallback(ctx,
      invites
        .map((invite) => {
          const status = invite.revoked
            ? ctx.t("invite-status-revoked")
            : invite.expires_at && invite.expires_at < Date.now()
              ? ctx.t("invite-status-expired")
              : ctx.t("invite-status-active");
          const expires = invite.expires_at ? formatInviteDate(invite.expires_at) : ctx.t("invite-exp-never");
          return `${invite.code} · ${invite.used_count}/${invite.max_uses} · ${expires} · ${status}`;
        })
        .join("\n"),
      {
        ...threadExtra(ctx.thread),
        reply_markup: invitesListKeyboard(ctx.t, invites),
      },
    );
  });
  bot.callbackQuery(/^inv:revoke:(.+)$/, async (ctx) => {
    logCallback(ctx, "invite:revoke");
    if (!isAdmin(ctx)) return;
    await ctx.services.repos.invites.revoke(ctx.match[1]!);
    ctx.services.logger.info("invite revoked", ctxLogMeta(ctx));
    await ctx.answerCallbackQuery({ text: ctx.t("invite-revoked-toast") });
    await ctx.editMessageText(ctx.t("invite-revoked")).catch(() => undefined);
  });
  bot.callbackQuery(/^inv:set:(\d+):(7d|30d|never)$/, async (ctx) => {
    logCallback(ctx, "invite:set");
    if (!isAdmin(ctx)) return;
    const uses = normalizeInviteUses(ctx.match[1]);
    const expiry = ctx.match[2] as InviteExpiry;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, inviteDraftText(ctx, uses, expiry), {
      reply_markup: inviteDraftKeyboard(ctx.t, uses, expiry),
    });
  });
  bot.callbackQuery(/^inv:create:(\d+):(7d|30d|never)$/, async (ctx) => {
    logCallback(ctx, "invite:create");
    if (!isAdmin(ctx)) return;
    const uses = normalizeInviteUses(ctx.match[1]);
    const expiry = ctx.match[2] as InviteExpiry;
    const code = await createUniqueInviteCode(ctx.services.repos);
    const expiresAt = expiryDate(expiry);
    const row = await ctx.services.repos.invites.insert({
      code,
      maxUses: uses,
      expiresAt,
      createdBy: ctx.from!.id,
    });
    ctx.services.logger.info("invite created", ctxLogMeta(ctx, {
      maxUses: row.max_uses,
      expiresAt: row.expires_at ?? null,
    }));
    const username = ctx.me.username ?? "your_bot";
    const link = `https://t.me/${username}?start=${row.code}`;
    const html = ctx.t("invite-created", {
      link: escapeHtml(link),
      code: escapeHtml(row.code),
      uses: row.max_uses,
      expires: row.expires_at ? formatInviteDate(row.expires_at) : ctx.t("invite-exp-never"),
    });
    const replyMarkup = {
      inline_keyboard: [[{ text: ctx.t("invite-btn-open"), url: link }]],
    };
    await ctx.answerCallbackQuery({ text: ctx.t("invite-created-toast") });
    await editOrReply(ctx, html, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  });
}

function inviteDraftText(ctx: BotContext, uses: number, expiry: InviteExpiry): string {
  return ctx.t("invite-draft", {
    uses,
    expires: expiryDisplay(ctx, expiry),
  });
}

function normalizeInviteUses(raw: string): number {
  const value = Number(raw);
  return inviteUseOptions.includes(value as typeof inviteUseOptions[number]) ? value : 1;
}

function expiryDate(expiry: InviteExpiry, now = Date.now()): number | null {
  if (expiry === "never") return null;
  const days = expiry === "7d" ? 7 : 30;
  return now + days * 24 * 60 * 60 * 1000;
}

function expiryDisplay(ctx: BotContext, expiry: InviteExpiry): string {
  const expiresAt = expiryDate(expiry);
  return expiresAt ? formatInviteDate(expiresAt) : ctx.t("invite-exp-never");
}

function formatInviteDate(expiresAt: number): string {
  return format(expiresAt, "yyyy-MM-dd");
}

async function createUniqueInviteCode(repos: Repos): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    const code = repos.invites.createCode();
    if (!(await repos.invites.get(code))) return code;
  }
  throw new Error("could not generate a unique invite code");
}
