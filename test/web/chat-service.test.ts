import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { GrammyError } from "grammy";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { DatabaseMemoryStore } from "../../src/memory/optmem/databaseStore.js";
import { sendFinal } from "../../src/ai/responseDelivery.js";
import { deferred } from "../helpers/async.js";
import { savedRestaurantOpenUi } from "./openui-saved-fixture.js";

describe("shared web and Telegram conversations", () => {
  let env: GrammyEmulator;
  let chat: BotChatService;
  let calls: { method: string; payload: unknown }[];
  beforeEach(async () => {
    env = await createGrammyEmulator({ privateTopics: true });
    await env.bot.sendCommand(env.user, env.chat, "/start");
    chat = new BotChatService({ services: env.services,
      repository: new ConversationRepository(env.db.db, env.repos, 999), api: env.bot.api });
    calls = [];
    env.bot.api.config.use((previous, method, payload, signal) => {
      calls.push({ method, payload });
      return previous(method, payload, signal);
    });
  });
  afterEach(async () => { await env.dispose(); });

  it("fetches the account's Telegram photo once, at a sharp size, and only when it is an image", async () => {
    let photos: { file_id: string; width: number }[][] = [[{ file_id: "small", width: 64 }, { file_id: "medium", width: 160 }, { file_id: "large", width: 640 }]];
    const lookups: unknown[] = [];
    env.bot.api.config.use((previous, method, payload, signal) => {
      if (method !== "getUserProfilePhotos") return previous(method, payload, signal);
      lookups.push(payload);
      return Promise.resolve({ ok: true, result: { total_count: photos.length, photos: photos.map(sizes => sizes.map(size => ({ ...size, file_unique_id: size.file_id, height: size.width }))) } } as never);
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
    const downloads: string[] = [];
    let download = async (fileId: string) => { downloads.push(fileId); return jpeg; };
    const service = () => new BotChatService({ services: env.services, repository: new ConversationRepository(env.db.db, env.repos, 999), api: env.bot.api,
      downloadFile: async input => ({ bytes: Buffer.from(await download(input.fileId)) }) as never });

    const photo = service();
    expect(await photo.avatar(env.user.id)).toEqual({ bytes: Buffer.from(jpeg), mime: "image/jpeg" });
    await photo.avatar(env.user.id);
    expect(downloads).toEqual(["medium"]);
    expect(lookups).toEqual([{ user_id: env.user.id, limit: 1 }]);
    await expect(photo.avatar(env.user.id + 1)).rejects.toThrow();

    download = async fileId => { downloads.push(fileId); throw new Error("Telegram is unavailable"); };
    const retried = service();
    expect(await retried.avatar(env.user.id)).toBeNull();
    download = async fileId => { downloads.push(fileId); return new TextEncoder().encode("<html>not a photo</html>"); };
    expect(await retried.avatar(env.user.id)).toBeNull();
    photos = [];
    expect(await service().avatar(env.user.id)).toBeNull();
    expect(downloads).toEqual(["medium", "medium", "medium"]);
  });

  it("returns the saved restaurant visualization through owner-scoped chat history", async () => {
    const thread = await chat.createThread(env.user.id, "Restaurant comparison");
    const text = "Din Tai Fung, Monsoon, Carmine’s and Seastar are four downtown Bellevue options.";
    const saved = await env.repos.messages.insert({ threadId: thread.id, role: "assistant", textPlain: text,
      content: { text, openui: savedRestaurantOpenUi } });
    const history = await chat.history(env.user.id, thread.id);
    expect(history.thread.origin).toBe("web");
    expect(history.messages).toEqual([expect.objectContaining({ id: saved.id, text, openui: savedRestaurantOpenUi })]);
    await expect(chat.history(env.user.id + 1, thread.id)).rejects.toThrow();
  });

  it("creates and uses website conversations when Telegram topic creation fails", async () => {
    env.bot.api.config.use((previous, method, payload, signal) => {
      if (method === "createForumTopic") throw new Error("Telegram unavailable");
      return previous(method, payload, signal);
    });
    const thread = await chat.createThread(env.user.id, "Website only");
    expect(thread.topicId).toBeNull();
    const sent = await chat.send(env.user.id, thread.id, { text: "Keep working", requestId: randomUUID() });
    expect((await env.repos.turnRuns.get(sent.turnId))?.status).toBe("succeeded");
    expect((await chat.history(env.user.id, thread.id)).messages.map(message => message.text))
      .toEqual(["Keep working", "Echo: Keep working"]);
    const general = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(general.id).not.toBe(thread.id);
  });

  it("creates a linked web thread, mirrors user and assistant quietly, and continues it from Telegram", async () => {
    const thread = await chat.createThread(env.user.id, "A shared conversation");
    expect(thread).toMatchObject({ origin: "web", title: "A shared conversation" });
    expect(thread.topicId).toBeGreaterThan(1);
    expect(env.bot.server.chatState.get(env.chat.id)?.forumTopics.has(thread.topicId!)).toBe(true);
    const sent = await chat.send(env.user.id, thread.id, { text: "Hello from the website", requestId: randomUUID() });
    const history = await chat.history(env.user.id, thread.id);
    expect(history.messages.map(message => [message.role, message.text])).toEqual([
      ["user", "Hello from the website"], ["assistant", "Echo: Hello from the website"],
    ]);
    expect((await env.repos.turnRuns.get(sent.turnId))?.status).toBe("succeeded");
    const outbound = calls.filter(call => ["sendMessage", "sendRichMessage"].includes(call.method));
    expect(outbound.length).toBeGreaterThanOrEqual(2);
    for (const call of outbound) expect(call.payload).toMatchObject({ disable_notification: true, message_thread_id: thread.topicId });
    expect(JSON.stringify(outbound)).toContain("🌐 Hello from the website");
    const echoed = await env.repos.messages.get(sent.messageId);
    expect(echoed?.tg_message_id).toBeGreaterThan(0);
    expect(outbound[0]?.payload).toMatchObject({ parse_mode: "HTML", text: "🌐 Hello from the website" });
    expect(outbound[0]?.payload).not.toHaveProperty("reply_parameters");
    for (const call of outbound.slice(1)) expect(call.payload).toMatchObject({ reply_parameters: { message_id: echoed?.tg_message_id, allow_sending_without_reply: true } });

    calls.length = 0;
    await env.bot.sendMessage(env.user, env.chat, "Continue on Telegram", { messageThreadId: thread.topicId! });
    const continued = await chat.history(env.user.id, thread.id);
    expect(continued.messages.map(message => message.text)).toContain("Continue on Telegram");
    expect(continued.thread.origin).toBe("web");
    const telegramCalls = calls.filter(call => ["sendMessage", "sendRichMessage"].includes(call.method));
    expect(telegramCalls.length).toBeGreaterThan(0);
    for (const call of telegramCalls) expect(call.payload).not.toHaveProperty("reply_parameters");
  });

  it("sends every bot message without a notification sound", async () => {
    // The emulator records calls innermost, after the bot's own transformers, so this is what Telegram receives.
    await env.bot.sendMessage(env.user, env.chat, "A question asked in Telegram");
    const replies = env.bot.getApiCalls().filter(call => ["sendMessage", "sendRichMessage"].includes(call.method));
    expect(replies.length).toBeGreaterThan(0);
    for (const call of replies) expect(call.payload).toMatchObject({ disable_notification: true });
    for (const call of env.bot.getApiCalls().filter(call => call.method === "sendChatAction")) expect(call.payload).not.toHaveProperty("disable_notification");
  });

  it("escapes and localizes quoted web input without changing its saved text", async () => {
    await chat.updateSettings(env.user.id, { language: "ru" });
    const thread = await chat.createThread(env.user.id, "Разговор");
    const text = "<b>не разметка</b> & привет 👋";
    const sent = await chat.send(env.user.id, thread.id, { text, requestId: randomUUID() });
    const echo = calls.find(call => call.method === "sendMessage");
    expect(echo?.payload).toMatchObject({ parse_mode: "HTML", text: "🌐 &lt;b&gt;не разметка&lt;/b&gt; &amp; привет 👋" });
    expect((await env.repos.messages.get(sent.messageId))?.text_plain).toBe(text);
  });

  it("searches titles and visible inherited messages with Unicode and literal wildcards", async () => {
    const parent = await chat.createThread(env.user.id, "Привет мир");
    const first = await chat.send(env.user.id, parent.id, { text: "unique 100%_literal", requestId: randomUUID() });
    await env.repos.messages.setPiEntryId(first.messageId, "search-checkpoint");
    const fork = await chat.fork(env.user.id, parent.id, first.messageId);
    await chat.send(env.user.id, parent.id, { text: "later-private-in-parent", requestId: randomUUID() });
    const nested = await env.repos.threads.create({ userId: env.user.id, title: "Nested", topicId: null, parentThreadId: fork.id, forkPointMessageId: first.messageId });
    await env.repos.users.ensure({ tgId: 2345 });
    const foreign = await env.repos.threads.create({ userId: 2345, title: "unique 100%_literal", topicId: null });
    expect((await chat.threads(env.user.id, 0, "ПРИВЕТ")).items.map(item => item.id)).toContain(parent.id);
    const matching = (await chat.threads(env.user.id, 0, "100%_literal")).items.map(item => item.id);
    expect(matching).toEqual(expect.arrayContaining([parent.id, fork.id, nested.id]));
    expect(matching).not.toContain(foreign.id);
    expect((await chat.threads(env.user.id, 0, "later-private-in-parent")).items.map(item => item.id)).toEqual([parent.id]);
    expect((await chat.threads(env.user.id, 0, "100%_nonexistent")).items).toEqual([]);
  });

  it("deduplicates simultaneous web retries and preserves Telegram thread origin", async () => {
    const thread = (await chat.threads(env.user.id, 0)).items[0]!;
    expect(thread.origin).toBe("telegram");
    const input = { text: "Once only", requestId: randomUUID() };
    const [a, b] = await Promise.all([chat.send(env.user.id, thread.id, input), chat.send(env.user.id, thread.id, input)]);
    const retry = await chat.send(env.user.id, thread.id, input);
    expect(a).toEqual(b);
    expect(retry.turnId).toBe(a.turnId);
    expect((await chat.history(env.user.id, thread.id)).messages).toHaveLength(2);
    expect((await chat.history(env.user.id, thread.id)).thread.origin).toBe("telegram");
    expect((await env.repos.turnRuns.get(a.turnId))?.origin).toBe("web");
    expect(await env.db.db.query(sql`select * from turn_run_sources`)).toHaveLength(0);
  });

  it("falls back quietly when a linked Telegram topic was deleted", async () => {
    const thread = await chat.createThread(env.user.id, "Deleted topic");
    env.bot.api.config.use((previous, method, payload, signal) => {
      if (method.startsWith("send") && "message_thread_id" in payload && payload.message_thread_id === thread.topicId) {
        throw new GrammyError("deleted topic", { ok: false, error_code: 400, description: "Bad Request: message thread not found" }, method, payload);
      }
      return previous(method, payload, signal);
    });
    const sent = await chat.send(env.user.id, thread.id, { text: "Still answer", requestId: randomUUID(),
      files: [new File(["available"], "note.txt", { type: "text/plain" })] });
    const history = await chat.history(env.user.id, thread.id);
    expect(history.messages).toHaveLength(2);
    expect(history.messages[0]?.telegramSyncFailed).toBeUndefined();
    expect((await env.repos.turnRuns.get(sent.turnId))?.status).toBe("succeeded");
    const outbound = calls.filter(call => ["sendMessage", "sendDocument", "sendRichMessage"].includes(call.method));
    expect(outbound.some(call => call.method === "sendDocument")).toBe(true);
    for (const call of outbound) {
      expect(call.payload).toMatchObject({ disable_notification: true });
      expect(call.payload).not.toHaveProperty("message_thread_id");
    }
  });

  it("keeps website replies available when Telegram rejects all mirrors", async () => {
    const thread = await chat.createThread(env.user.id, "Blocked bot");
    env.bot.api.config.use((previous, method, payload, signal) => {
      if (["sendMessage", "sendRichMessage"].includes(method)) {
        throw new GrammyError("blocked", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, method, payload);
      }
      return previous(method, payload, signal);
    });
    const input = { text: "Answer on the website", requestId: randomUUID() };
    const sent = await chat.send(env.user.id, thread.id, input);
    const history = await chat.history(env.user.id, thread.id);
    expect(history.messages.map(message => message.text)).toEqual(["Answer on the website", "Echo: Answer on the website"]);
    expect(history.messages[0]?.telegramSyncFailed).toBe(true);
    expect(history.thread.activity).toBeNull();
    expect((await chat.send(env.user.id, thread.id, input)).turnId).toBe(sent.turnId);
    expect((await chat.history(env.user.id, thread.id)).messages).toHaveLength(2);
  });

  it("shares settings and paginated memory with Telegram without exposing another user", async () => {
    await chat.updateSettings(env.user.id, { language: "ru", timeZone: "europe/moscow", streaming: false, memoryEnabled: false });
    expect(await env.repos.users.get(env.user.id)).toMatchObject({ lang: "ru", tz_name: "Europe/Moscow", tz_offset_min: 180, stream_mode: 0, memory_enabled: 0 });
    expect(await chat.settings(env.user.id)).toMatchObject({ timeZone: "Europe/Moscow", timezoneOffsetMinutes: 180 });
    await expect(chat.updateSettings(env.user.id, { timeZone: "Mars/Olympus_Mons" })).rejects.toMatchObject({ status: 400 });
    await env.bot.sendCommand(env.user, env.chat, "/stream");
    expect((await chat.settings(env.user.id)).streaming).toBe(true);
    // A Telegram offset replaces the name; the website shows it until a zone is picked.
    await env.repos.users.setTimezone(env.user.id, -300);
    expect(await chat.settings(env.user.id)).toMatchObject({ timeZone: null, timezoneOffsetMinutes: -300 });
    await chat.updateSettings(env.user.id, { timeZone: null });
    expect(await chat.settings(env.user.id)).toMatchObject({ timeZone: null, timezoneOffsetMinutes: null });
    const store = new DatabaseMemoryStore(env.db.db, env.user.id);
    await chat.updateSettings(env.user.id, { memoryEnabled: true });
    await store.initialize();
    await store.append([["2026-10-22", "Prefers short replies"]]);
    await chat.updateSettings(env.user.id, { memoryEnabled: false });
    expect(await chat.memories(env.user.id, 0)).toMatchObject({ enabled: false, total: 1, items: [{ text: "Prefers short replies" }] });
    const thread = (await chat.threads(env.user.id, 0)).items[0]!;
    await expect(chat.history(2345, thread.id)).rejects.toThrow();
    await expect(chat.send(2345, thread.id, { text: "intrusion", requestId: randomUUID() })).rejects.toThrow();
    await expect(chat.stop(2345, thread.id)).rejects.toThrow();
    await expect(chat.fork(2345, thread.id)).rejects.toThrow();
  });

  it("retains upload bytes and echoes attachments through the same durable turn", async () => {
    const thread = await chat.createThread(env.user.id, "Files");
    const sent = await chat.send(env.user.id, thread.id, { text: "Read this", requestId: randomUUID(),
      files: [new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" })] });
    const history = await chat.history(env.user.id, thread.id);
    expect(history.messages[0]?.attachments).toMatchObject([{ name: "data.csv", mimeType: "text/csv" }]);
    const file = await env.repos.files.get(history.messages[0]!.attachments[0]!.id);
    expect(file?.message_id).toBe(sent.messageId);
    const local = (await env.repos.files.listSources(file!.id)).find(source => source.transport === "local");
    expect(local).toBeDefined();
    const resolved = await env.services.fileResolver.resolveFile(file!);
    expect(resolved.bytes.toString()).toBe("a,b\n1,2\n");
    expect(calls.find(call => call.method === "sendDocument")?.payload).toMatchObject({ disable_notification: true, message_thread_id: thread.topicId });
    expect((await env.repos.turnRuns.get(sent.turnId))?.status).toBe("succeeded");
  });

  it("forks a visible point without pulling later messages into the new history", async () => {
    const parent = await chat.createThread(env.user.id, "Original");
    const first = await chat.send(env.user.id, parent.id, { text: "First", requestId: randomUUID() });
    await env.repos.messages.setPiEntryId(first.messageId, "first-user-checkpoint");
    await chat.send(env.user.id, parent.id, { text: "Future", requestId: randomUUID() });
    const fork = await chat.fork(env.user.id, parent.id, first.messageId);
    const history = await chat.history(env.user.id, fork.id);
    expect(history.messages.map(message => message.text)).toEqual(["First"]);
    expect(fork).toMatchObject({ origin: "web", parentThreadId: parent.id, forkPointMessageId: first.messageId });
    await expect(chat.fork(env.user.id, parent.id, 999999)).rejects.toThrow();
  });

  it("forks empty chats and rejects explicit points without a model checkpoint", async () => {
    const empty = await chat.createThread(env.user.id, "Empty");
    const fork = await chat.fork(env.user.id, empty.id);
    expect((await chat.history(env.user.id, fork.id)).messages).toEqual([]);
    const sent = await chat.send(env.user.id, empty.id, { text: "No checkpoint in this test runner", requestId: randomUUID() });
    await expect(chat.fork(env.user.id, empty.id, sent.messageId)).rejects.toThrow("no saved model checkpoint");
    const whole = await chat.fork(env.user.id, empty.id);
    expect((await chat.history(env.user.id, whole.id)).messages).toHaveLength(2);
  });

  it("keeps origin and accepted web requests through repeated schema initialization", async () => {
    const thread = await chat.createThread(env.user.id, "Durable");
    const input = { text: "Survives", requestId: randomUUID() };
    const sent = await chat.send(env.user.id, thread.id, input);
    await env.db.initialize();
    expect((await env.repos.threads.get(thread.id))?.origin).toBe("web");
    expect((await chat.send(env.user.id, thread.id, input)).turnId).toBe(sent.turnId);
  });

  it("exposes a live draft only to the owner and removes it when the answer is persisted", async () => {
    await env.dispose();
    const started = deferred<void>();
    const release = deferred<void>();
    env = await createGrammyEmulator({ privateTopics: true, turnRunner: async input => {
      input.onDraft?.({ text: "Working on the answer", thinking: "Checking the facts" });
      started.resolve();
      await release.promise;
      await sendFinal(input, "Checking the facts", "The completed answer");
    } });
    await env.bot.sendCommand(env.user, env.chat, "/start");
    chat = new BotChatService({ services: env.services,
      repository: new ConversationRepository(env.db.db, env.repos, 999), api: env.bot.api });
    const thread = await chat.createThread(env.user.id, "Streaming");
    const send = chat.send(env.user.id, thread.id, { text: "Explain", requestId: randomUUID() });
    try {
      await started.promise;
      expect((await chat.history(env.user.id, thread.id)).draft).toEqual({ text: "Working on the answer", thinking: "Checking the facts" });
      await expect(chat.history(2345, thread.id)).rejects.toThrow();
    } finally { release.resolve(); await send; }
    expect((await chat.history(env.user.id, thread.id)).draft).toBeNull();
    expect((await chat.history(env.user.id, thread.id)).messages.at(-1)?.text).toBe("The completed answer");
  });
});
