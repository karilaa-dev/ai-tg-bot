import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { BotChatService } from "../../src/web/chat-service.js";

describe("shared web and Telegram read state", () => {
  let env: GrammyEmulator;
  let chat: BotChatService;
  beforeEach(async () => {
    env = await createGrammyEmulator({ privateTopics: true });
    await env.bot.sendCommand(env.user, env.chat, "/start");
    chat = new BotChatService({ services: env.services, repository: new ConversationRepository(env.db.db, env.repos), api: env.bot.api });
  });
  afterEach(async () => { vi.restoreAllMocks(); await env.dispose(); });

  it("does not mark read on history polling and shares explicit web acknowledgement persistently", async () => {
    const thread = await chat.createThread(env.user.id, "Read this");
    const saved = await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "Unread reply", content: {} });
    expect((await chat.threads(env.user.id, 0)).items.find(t => t.id === thread.id)).toMatchObject({ unread: true, lastMessageId: saved.id });
    for (let i = 0; i < 2; i++) expect((await chat.history(env.user.id, thread.id)).thread).toMatchObject({ unread: true, lastMessageId: saved.id });
    expect(await chat.markRead(env.user.id, thread.id, saved.id)).toEqual({ readMessageId: saved.id, unread: false });
    expect((await chat.history(env.user.id, thread.id)).thread.unread).toBe(false);
    await expect(chat.markRead(env.user.id + 1, thread.id, saved.id)).rejects.toThrow();
    await expect(chat.markRead(env.user.id, thread.id, saved.id + 1)).rejects.toThrow();
  });

  it("marks prior replies read on Telegram input but leaves the new assistant reply unread", async () => {
    const thread = await chat.createThread(env.user.id, "Shared topic");
    const prior = await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "Earlier reply", content: {} });
    await env.bot.sendMessage(env.user, env.chat, "Continue", { messageThreadId: thread.topicId! });
    const history = await chat.history(env.user.id, thread.id);
    const state = (await env.repos.threadReads.states(env.user.id, [thread.id])).get(thread.id);
    expect(state?.readMessageId).toBe(prior.id);
    expect(history.thread.unread).toBe(true);
    expect(history.messages.at(-1)?.text).toBe("Echo: Continue");
    await env.bot.sendCommand(env.user, env.chat, "/help", { messageThreadId: thread.topicId! });
    expect((await chat.history(env.user.id, thread.id)).thread.unread).toBe(false);
  });

  it("marks callback interactions read without adding a Mark read button", async () => {
    const picker = await env.bot.sendCommand(env.user, env.chat, "/lang");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const saved = await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "Before callback", content: {} });
    await env.bot.clickButton(env.user, env.chat, "lang:en", picker.messages.at(-1)!);
    expect((await env.repos.threadReads.states(env.user.id, [thread.id])).get(thread.id)).toMatchObject({ readMessageId: saved.id, unread: false });
  });

  it("limits history acknowledgement metadata to the messages actually included in each page", async () => {
    const thread = await chat.createThread(env.user.id, "Long conversation");
    for (let index = 0; index < 53; index++) await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: `Reply ${index}`, content: {} });
    const all = await env.repos.messages.listThread(thread.id);
    const page = await chat.history(env.user.id, thread.id, undefined, all[0]!.id);
    expect(page.messages).toHaveLength(50);
    expect(page.thread.lastMessageId).toBe(page.messages.at(-1)?.id);
    await chat.markRead(env.user.id, thread.id, page.thread.lastMessageId!);
    expect((await chat.threads(env.user.id, 0)).items.find(t => t.id === thread.id)?.unread).toBe(true);
    expect(await env.db.db.query(sql`select message_id from thread_reads where thread_id = ${thread.id}`)).toEqual([{ message_id: all[49]!.id }]);
  });

  it("does not expose an acknowledgement cursor for a reply racing the history query", async () => {
    const thread = await chat.createThread(env.user.id, "Racing reply");
    const shown = await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "Shown", content: {} });
    const states = env.repos.threadReads.states.bind(env.repos.threadReads);
    vi.spyOn(env.repos.threadReads, "states").mockImplementationOnce(async (...args) => {
      const snapshot = await states(...args);
      await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "Arrived after page query", content: {} });
      return snapshot;
    });
    const history = await chat.history(env.user.id, thread.id);
    expect(history.messages.map(message => message.text)).toEqual(["Shown", "Arrived after page query"]);
    expect(history.thread.lastMessageId).toBe(shown.id);
    expect(await chat.markRead(env.user.id, thread.id, shown.id)).toEqual({ readMessageId: shown.id, unread: true });
  });

  it("does not mark replies produced concurrently in a new fork as already read", async () => {
    const parent = await chat.createThread(env.user.id, "Fork source");
    const inherited = await env.repos.messages.insert({ threadId: parent.id, role: "assistant", textPlain: "Inherited", content: {} });
    vi.spyOn(env.services.pi, "fork").mockImplementationOnce(async (_parent, child) => {
      await env.repos.messages.insert({ threadId: child.id, role: "assistant", textPlain: "New child reply", content: {} });
    });
    const fork = await chat.fork(env.user.id, parent.id);
    expect(fork.unread).toBe(true);
    expect((await env.repos.threadReads.states(env.user.id, [fork.id])).get(fork.id)?.readMessageId).toBe(inherited.id);
  });

  it("renders finalized attachments before offering their acknowledgement cursor", async () => {
    const thread = await chat.createThread(env.user.id, "Pending content race");
    const accepted = await env.repos.turnRuns.accept({ userId: env.user.id, threadId: thread.id, chatId: env.user.id,
      messageThreadId: thread.topicId, locale: "en", kind: "text", textPlain: "Generate file", content: {}, sources: [{ updateId: 555, messageId: 555 }] });
    await env.db.db.execute(sql`update turn_runs set status = 'awaiting_delivery', lease_expires_at = ${Date.now() + 60_000} where id = ${accepted.turnRun.id}`);
    const pending = await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: "", content: { attachmentDeliveryTurnId: accepted.turnRun.id } });
    const file = await env.repos.files.insertFile({ userId: env.user.id, threadId: thread.id, messageId: pending.id,
      type: "other", name: "report.zip", size: 10, isInline: false });
    const states = env.repos.threadReads.states.bind(env.repos.threadReads);
    vi.spyOn(env.repos.threadReads, "states").mockImplementationOnce(async (...args) => {
      await env.repos.messages.setDeliveryContent({ messageId: pending.id, textPlain: "Finalized", content: {}, tgMessageId: null });
      return states(...args);
    });
    const history = await chat.history(env.user.id, thread.id);
    expect(history.thread.lastMessageId).toBe(pending.id);
    expect(history.messages.at(-1)).toMatchObject({ text: "Finalized", attachments: [{ id: file.id }] });
  });
});
