import { afterEach, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { ThreadRow } from "../../src/db/types.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";

let env: GrammyEmulator;
beforeEach(async () => { env = await createGrammyEmulator(); });
afterEach(async () => { await env.dispose(); });

function visitor() {
  const user = env.bot.createUser({ id: 2002, first_name: "New user", language_code: "en" });
  const chat = env.bot.createChat({ id: user.id, type: "private", first_name: user.first_name });
  return { user, chat };
}

async function storedState() {
  const tables = ["users", "threads", "messages", "files", "thread_reads", "turn_runs"];
  const rows = await Promise.all(tables.map(table => env.db.db.query(sql`select * from ${sql.identifier(table)}`)));
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
}

it("rejects unlisted commands, text, uploads and callbacks without database writes", async () => {
  const { user, chat } = visitor();
  const before = await storedState();
  const denied = await env.bot.sendCommand(user, chat, "/start");
  expect(denied.text).toContain("Access is restricted");
  await env.bot.sendMessage(user, chat, "Hello");
  await env.bot.sendDocument(user, chat, { fileName: "private.txt", mimeType: "text/plain", content: Buffer.from("private") });
  const message = denied.messages.at(-1);
  expect(message).toBeDefined();
  if (message) await env.bot.clickButton(user, chat, "lang:ru", message);
  expect(await storedState()).toEqual(before);
});

it("registers an invited user only through /start addressed to this bot", async () => {
  const { user, chat } = visitor();
  await env.services.access.allow(user.id);
  const before = await storedState();
  for (const command of ["/help", "/starter", "/start@another_bot"]) {
    expect((await env.bot.sendCommand(user, chat, command)).text).toContain("Send /start");
  }
  await env.bot.sendMessage(user, chat, "Hello");
  await env.bot.sendDocument(user, chat, { fileName: "pending.txt", mimeType: "text/plain", content: Buffer.from("pending") });
  expect(await storedState()).toEqual(before);
  await env.bot.sendCommand(user, chat, "/start@ai_test_bot invited");
  expect(await env.repos.users.get(user.id)).toMatchObject({ tg_id: user.id, first_name: user.first_name });
  const entry = (await env.services.access.list()).find(item => item.telegramId === user.id);
  expect(entry?.registered).toBe(true);
});

it("blocks a revoked existing user before profile, thread, message or file writes", async () => {
  const picker = await env.bot.sendCommand(env.user, env.chat, "/lang");
  await env.services.access.revoke(env.user.id);
  const before = await storedState();
  const changed = env.bot.createUser({ id: env.user.id, first_name: "Must not be saved", language_code: "en" });
  expect((await env.bot.sendCommand(changed, env.chat, "/start")).text).toContain("Access is restricted");
  await env.bot.sendMessage(changed, env.chat, "No turn");
  await env.bot.sendDocument(changed, env.chat, { fileName: "blocked.txt", mimeType: "text/plain", content: Buffer.from("blocked") });
  const message = picker.messages.at(-1);
  expect(message).toBeDefined();
  if (message) await env.bot.clickButton(changed, env.chat, "lang:ru", message);
  expect(await storedState()).toEqual(before);
});

it("lets an allowed existing user continue without repeating /start", async () => {
  await env.bot.sendMessage(env.user, env.chat, "Existing conversation");
  const threads = await env.db.db.query<ThreadRow>(sql`select * from threads where user_id = ${env.user.id}`);
  expect(threads).toHaveLength(1);
  expect((await env.repos.messages.listThread(threads[0]!.id)).some(message => message.text_plain === "Existing conversation")).toBe(true);
});
