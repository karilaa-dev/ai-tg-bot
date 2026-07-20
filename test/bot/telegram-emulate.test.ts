import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { BotResponse } from "@bonkers-agency/grammy-test";
import { sql } from "drizzle-orm";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { sendFinal, type TurnInput } from "../../src/ai/run.js";
import type { ThreadRow } from "../../src/db/types.js";
import type { PiRuntimeService } from "../../src/pi/runtime.js";

describe("Telegram bot with grammy-emulate", () => {
  let env: GrammyEmulator;

  beforeEach(async () => {
    env = await createGrammyEmulator();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.dispose();
  });

  it("onboards a brand-new private-chat user without an invite", async () => {
    const onboarded = await env.bot.sendCommand(env.user, env.chat, "/start");
    const richWelcome = JSON.stringify(onboarded.getLastApiCall("sendRichMessage")?.payload);
    expect(richWelcome).toContain("# 👋 Welcome to your AI assistant");
    expect(richWelcome).toContain("## What I can help with");
    expect(richWelcome).toContain("- 🔎 *Search*:");
    expect(richWelcome).toContain("- 🎨 *Images*:");
    expect(richWelcome).toContain("- 💻 *Code*:");
    expect(richWelcome).toContain("- 📎 *Files*:");
    expect(richWelcome).not.toContain("###");
    expect(richWelcome).not.toContain("Try asking");
    expect(richWelcome).not.toContain("Stream mode");
    const surface = onboarded.texts.join("\n");
    expect(surface).toContain("Set your timezone");
    expect(surface).not.toContain("Stream mode");
    expect(surface).not.toContain("Choose a language");
    expect(onboarded.getInlineButtonByData("tz:onboarding:set")).toBeDefined();
    expect(onboarded.getInlineButtonByData("tz:onboarding:later")).toBeDefined();
    expect(await env.repos.users.get(env.user.id)).toMatchObject({
      tg_id: env.user.id,
      first_name: "Alice",
      lang: "en",
    });
  });

  it("leaves non-private chats after a localized notice", async () => {
    const group = env.bot.createChat({ id: -100, type: "supergroup", title: "Group" });
    const res = await env.bot.sendCommand(env.user, group, "/start");

    expect(res.text).toContain("private chats");
    expect(res.getLastApiCall("leaveChat")).toBeDefined();
    expect(await env.repos.users.get(env.user.id)).toBeUndefined();
  });

  it("treats a legacy /start payload as ordinary onboarding", async () => {
    const onboarded = await env.bot.sendCommand(env.user, env.chat, "/start LEGACY-CODE");

    expect(JSON.stringify(onboarded.getLastApiCall("sendRichMessage")?.payload)).toContain("Welcome to your AI assistant");
    expect(onboarded.texts.join("\n")).toContain("Set your timezone");
    expect(await env.repos.users.get(env.user.id)).toBeDefined();
  });

  it("persists language and stream settings", async () => {
    await startBot();
    const picker = await env.bot.sendCommand(env.user, env.chat, "/lang");
    const lang = await env.bot.clickButton(env.user, env.chat, "lang:ru", picker.messages.at(-1)!);
    expect(lang.text ?? lang.editedText).toContain("русский");
    const commandCall = lang.getLastApiCall("setMyCommands");
    expect(JSON.stringify(commandCall?.payload)).toContain("Сменить язык");
    expect(JSON.stringify(commandCall?.payload)).toContain(`"chat_id":${env.chat.id}`);
    const stream = await env.bot.sendCommand(env.user, env.chat, "/stream");
    expect(stream.text).toContain("выключены");
    const user = await env.repos.users.get(env.user.id);
    expect(user?.lang).toBe("ru");
    expect(user?.stream_mode).toBe(0);
  });

  it("collects timezone through a conversation", async () => {
    await startBot();
    const prompt = await env.bot.sendCommand(env.user, env.chat, "/timezone");
    expect(prompt.text).toContain("What time");

    const retry = await env.bot.sendMessage(env.user, env.chat, "not a time");
    expect(retry.text).toContain("could not parse");

    const done = await env.bot.sendMessage(env.user, env.chat, "2:30 PM");
    expect(done.texts.join("\n")).toContain("Timezone saved");
    expect(done.texts.join("\n")).toContain("Ready");
    const user = await env.repos.users.get(env.user.id);
    expect(typeof user?.tz_offset_min).toBe("number");
  });

  it("lets users postpone timezone setup from onboarding", async () => {
    const onboarded = await startBot();
    const later = await env.bot.clickButton(env.user, env.chat, "tz:onboarding:later", onboarded.messages.at(-1)!);

    expect(later.text).toContain("/timezone");
    const user = await env.repos.users.get(env.user.id);
    expect(user?.tz_offset_min).toBeNull();
  });

  it("starts the default timezone flow from the onboarding button", async () => {
    const onboarded = await startBot();
    const prompt = await env.bot.clickButton(env.user, env.chat, "tz:onboarding:set", onboarded.messages.at(-1)!);
    expect(prompt.text).toContain("What time");

    const done = await env.bot.sendMessage(env.user, env.chat, "2:30 PM");
    expect(done.texts.join("\n")).toContain("Timezone saved");
    expect(done.texts.join("\n")).toContain("Ready");
    const user = await env.repos.users.get(env.user.id);
    expect(typeof user?.tz_offset_min).toBe("number");
  });

  it("offers Moscow timezone directly for Russian-language users", async () => {
    const ruUser = env.bot.createUser({ id: env.user.id + 1, first_name: "Alina", language_code: "ru" });
    const ruChat = env.bot.createChat({ id: ruUser.id, type: "private", first_name: "Alina" }) as typeof env.chat;
    const onboarded = await startBot(ruUser, ruChat);

    expect(onboarded.getInlineButtonByData("tz:onboarding:moscow")).toBeDefined();
    const done = await env.bot.clickButton(ruUser, ruChat, "tz:onboarding:moscow", onboarded.messages.at(-1)!);
    expect(done.texts.join("\n")).toContain("UTC+03:00");
    expect(done.texts.join("\n")).toContain("Готово");
    const user = await env.repos.users.get(ruUser.id);
    expect(user?.lang).toBe("ru");
    expect(user?.tz_offset_min).toBe(180);
  });

  it("does not show onboarding timezone prompt when timezone is already set", async () => {
    await startBot();
    await env.repos.users.setTimezone(env.user.id, -420);

    const restarted = await env.bot.sendCommand(env.user, env.chat, "/start");

    const richWelcome = JSON.stringify(restarted.getLastApiCall("sendRichMessage")?.payload);
    expect(richWelcome).toContain("# 👋 Welcome to your AI assistant");
    expect(restarted.getInlineButtonByData("tz:onboarding:set")).toBeUndefined();
  });

  it("runs a brand-new user's text through the turn runner", async () => {
    const res = await env.bot.sendMessage(env.user, env.chat, "Hello bot");
    expectRichCall(res, "Echo: Hello bot");
    const rows = await env.repos.messages.listThread((await env.repos.threads.activeForUserTopic(env.user.id, null)).id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("coalesces Telegram-split large text into one user turn", async () => {
    await startBot();
    const firstChunk = "a".repeat(4096);
    const secondChunk = "b".repeat(4096);
    const tail = "\nlast split chunk";

    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, firstChunk),
    ]);
    await wait(750);
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, secondChunk),
    ]);
    await wait(750);
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, tail),
    ]);
    await wait(1_150);

    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const rows = await env.repos.messages.listThread(thread.id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.text_plain).toBe(`${firstChunk}\n\n${secondChunk}\n\n${tail}`);
    expect(rows[1]?.text_plain).toContain(tail);
  });

  it("does not coalesce quick short text messages", async () => {
    await startBot();

    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, "first quick text"),
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, "second quick text"),
    ]);

    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const rows = await env.repos.messages.listThread(thread.id);
    expect(rows.map((row) => [row.role, row.text_plain])).toEqual([
      ["user", "first quick text"],
      ["assistant", "Echo: first quick text"],
      ["user", "second quick text"],
      ["assistant", "Echo: second quick text"],
    ]);
  });

  it("keeps split text bursts scoped to Telegram topics", async () => {
    await env.dispose();
    env = await createGrammyEmulator({ privateTopics: true });
    await startBot();
    const firstChunk = "t".repeat(4096);
    const otherTopicText = "other topic text";

    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, firstChunk, { messageThreadId: 61 }),
    ]);
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createTextMessage(env.user, env.chat, otherTopicText, { messageThreadId: 62 }),
    ]);
    await wait(1_150);

    const firstTopic = await env.repos.threads.activeForUserTopic(env.user.id, 61);
    const otherTopic = await env.repos.threads.activeForUserTopic(env.user.id, 62);
    expect((await env.repos.messages.listThread(firstTopic.id)).map((row) => [row.role, row.text_plain])).toEqual([
      ["user", firstChunk],
      ["assistant", `Echo: ${firstChunk}`],
    ]);
    expect((await env.repos.messages.listThread(otherTopic.id)).map((row) => [row.role, row.text_plain])).toEqual([
      ["user", otherTopicText],
      ["assistant", `Echo: ${otherTopicText}`],
    ]);
  });

  it("warns when /fork is used before private topics are enabled", async () => {
    await startBot();
    const res = await env.bot.sendCommand(env.user, env.chat, "/fork");
    expect(res.text).toContain("Topics are not enabled");
  });

  it("creates a fork topic and child thread when private topics are enabled", async () => {
    await env.dispose();
    env = await createGrammyEmulator({ privateTopics: true });
    await startBot();
    const parent = await env.repos.threads.activeForUserTopic(env.user.id, null);
    await env.bot.sendMessage(env.user, env.chat, "context before fork");

    const res = await env.bot.sendCommand(env.user, env.chat, "/fork");

    expect(res.text).toContain("Fork created");
    const child = (await env.db.db.query<ThreadRow>(sql`select * from threads where parent_thread_id = ${parent.id} limit 1`))[0];
    const latestParentMessage = await env.repos.messages.latest(parent.id);
    expect(child).toMatchObject({
      parent_thread_id: parent.id,
      fork_point_message_id: latestParentMessage?.id,
      topic_id: 2,
      title_source: "explicit",
    });
  });

  it("treats a Telegram-created topic as a clean thread", async () => {
    await env.dispose();
    env = await createGrammyEmulator({ privateTopics: true });
    await startBot();
    const general = await env.repos.threads.activeForUserTopic(env.user.id, null);
    await env.bot.sendMessage(env.user, env.chat, "general-only detail");

    const res = await env.bot.sendMessage(env.user, env.chat, "topic-only detail", { messageThreadId: 77 });

    expectRichCall(res, "Echo: topic-only detail");
    const topic = await env.repos.threads.activeForUserTopic(env.user.id, 77);
    expect(topic.id).not.toBe(general.id);
    expect(topic.parent_thread_id).toBeNull();
    expect(topic.fork_point_message_id).toBeNull();
    expect((await env.repos.messages.listThread(topic.id)).map((row) => [row.role, row.text_plain])).toEqual([
      ["user", "topic-only detail"],
      ["assistant", "Echo: topic-only detail"],
    ]);
    expect((await env.repos.messages.listThread(general.id)).map((row) => row.text_plain)).toContain("general-only detail");
  });

  it("ignores Telegram topic service messages before command or text in that topic", async () => {
    await env.dispose();
    env = await createGrammyEmulator({ privateTopics: true });
    await startBot();
    const update = env.bot.server.updateFactory.createForumTopicCreated(
      env.user,
      env.chat,
      { name: "Manual topic", icon_color: 0x6fb9f0 },
      88,
    );

    const [serviceResponse] = await env.bot.processUpdatesConcurrently([update]);
    expect(serviceResponse?.texts).toEqual([]);
    expect(serviceResponse?.getLastApiCall("sendMessage")).toBeUndefined();

    const help = await env.bot.sendCommand(env.user, env.chat, "/help", { messageThreadId: 88 });
    expect(help.text).toContain("Commands:");
    expect(help.text).not.toContain("not supported");
    const question = await env.bot.sendMessage(env.user, env.chat, "first question in manual topic", { messageThreadId: 88 });
    expectRichCall(question, "Echo: first question in manual topic");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, 88);
    expect(thread).toMatchObject({ title: "Manual topic", title_source: "explicit", title_attempts: 0 });
    expect((await env.repos.messages.listThread(thread.id)).map((row) => row.text_plain)).toContain("first question in manual topic");
  });

  it("generates and synchronizes a short title for a new implicit topic", async () => {
    await env.dispose();
    let titleInput: { userText: string; assistantText?: string } | undefined;
    env = await createGrammyEmulator({
      privateTopics: true,
      pi: piWithTitleGenerator(async (input) => {
        titleInput = input;
        return "**Telegram Thread Naming Logic.**";
      }),
    });
    await createTopic(env, 89, "New topic", true);

    const response = await env.bot.sendMessage(env.user, env.chat, "research useful thread titles", { messageThreadId: 89 });
    expectRichCall(response, "Echo: research useful thread titles");
    await env.services.threadTitles.waitForIdle();

    const thread = await env.repos.threads.activeForUserTopic(env.user.id, 89);
    expect(thread).toMatchObject({
      title: "Telegram Thread Naming Logic",
      title_source: "generated",
      title_attempts: 1,
      topic_title_synced: 1,
    });
    expect(titleInput).toEqual({
      userText: "research useful thread titles",
      assistantText: "Echo: research useful thread titles",
    });
    expect(env.bot.server.chatState.get(env.chat.id)?.forumTopics.get(89)?.topic.name)
      .toBe("Telegram Thread Naming Logic");
  });

  it("retries failed helper calls up to a later successful turn", async () => {
    await env.dispose();
    let calls = 0;
    env = await createGrammyEmulator({
      privateTopics: true,
      pi: piWithTitleGenerator(async () => {
        calls += 1;
        if (calls < 3) throw new Error("helper unavailable");
        return "Recovered Topic Title";
      }),
    });
    await createTopic(env, 90, "New topic", true);

    for (const text of ["first request", "second request", "third request"]) {
      await env.bot.sendMessage(env.user, env.chat, text, { messageThreadId: 90 });
      await env.services.threadTitles.waitForIdle();
    }

    expect(calls).toBe(3);
    expect(await env.repos.threads.activeForUserTopic(env.user.id, 90)).toMatchObject({
      title: "Recovered Topic Title",
      title_source: "generated",
      title_attempts: 3,
      topic_title_synced: 1,
    });
  });

  it("retries Telegram synchronization without calling the helper again", async () => {
    await env.dispose();
    let helperCalls = 0;
    let editCalls = 0;
    env = await createGrammyEmulator({
      privateTopics: true,
      pi: piWithTitleGenerator(async () => {
        helperCalls += 1;
        return "Durable Generated Topic";
      }),
    });
    await createTopic(env, 91, "New topic", true);
    env.bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "editForumTopic") {
        editCalls += 1;
        if (editCalls === 1) {
          return { ok: false, error_code: 400, description: "Bad Request: forced title sync failure" } as never;
        }
      }
      return prev(method, payload, signal);
    });

    await env.bot.sendMessage(env.user, env.chat, "durable naming", { messageThreadId: 91 });
    await env.services.threadTitles.waitForIdle();
    expect(await env.repos.threads.activeForUserTopic(env.user.id, 91)).toMatchObject({
      title_source: "generated",
      topic_title_synced: 0,
    });

    await env.bot.sendMessage(env.user, env.chat, "retry the sync", { messageThreadId: 91 });
    await env.services.threadTitles.waitForIdle();
    expect(helperCalls).toBe(1);
    expect(editCalls).toBe(2);
    expect(await env.repos.threads.activeForUserTopic(env.user.id, 91)).toMatchObject({
      title: "Durable Generated Topic",
      topic_title_synced: 1,
    });
  });

  it("does not overwrite a manual rename that arrives while the helper is running", async () => {
    await env.dispose();
    let startGeneration!: () => void;
    let releaseGeneration!: (title: string) => void;
    const started = new Promise<void>((resolve) => { startGeneration = resolve; });
    const generated = new Promise<string>((resolve) => { releaseGeneration = resolve; });
    env = await createGrammyEmulator({
      privateTopics: true,
      pi: piWithTitleGenerator(async () => {
        startGeneration();
        return generated;
      }),
    });
    await createTopic(env, 92, "New topic", true);
    await env.bot.sendMessage(env.user, env.chat, "rename race", { messageThreadId: 92 });
    await started;

    const edit = env.bot.server.updateFactory.createForumTopicCreated(
      env.user,
      env.chat,
      { name: "Manual Choice", icon_color: 0x6fb9f0 },
      92,
    );
    const message = edit.message as typeof edit.message & Record<string, unknown>;
    delete message.forum_topic_created;
    message.forum_topic_edited = { name: "Manual Choice" };
    const state = env.bot.server.chatState.get(env.chat.id);
    if (state) state.forumTopics.get(92)!.topic.name = "Manual Choice";
    await env.bot.processUpdatesConcurrently([edit]);

    releaseGeneration("Model Generated Topic");
    await env.services.threadTitles.waitForIdle();
    expect(await env.repos.threads.activeForUserTopic(env.user.id, 92)).toMatchObject({
      title: "Manual Choice",
      title_source: "explicit",
      topic_title_synced: 1,
    });
    expect(state?.forumTopics.get(92)?.topic.name).toBe("Manual Choice");
  });

  it("deduplicates title generation while a helper job is in flight", async () => {
    await env.dispose();
    let calls = 0;
    let startGeneration!: () => void;
    let releaseGeneration!: (title: string) => void;
    const started = new Promise<void>((resolve) => { startGeneration = resolve; });
    const generated = new Promise<string>((resolve) => { releaseGeneration = resolve; });
    env = await createGrammyEmulator({
      privateTopics: true,
      pi: piWithTitleGenerator(async () => {
        calls += 1;
        startGeneration();
        return generated;
      }),
    });
    await createTopic(env, 93, "New topic", true);
    await env.bot.sendMessage(env.user, env.chat, "first naming request", { messageThreadId: 93 });
    await started;
    await env.bot.sendMessage(env.user, env.chat, "second naming request", { messageThreadId: 93 });

    releaseGeneration("Only One Title Call");
    await env.services.threadTitles.waitForIdle();
    expect(calls).toBe(1);
    expect(await env.repos.threads.activeForUserTopic(env.user.id, 93)).toMatchObject({
      title: "Only One Title Call",
      title_attempts: 1,
    });
  });

  it("retries command replies without a stale private topic id", async () => {
    await startBot();
    const sendMessagePayloads: Array<Record<string, unknown>> = [];
    env.bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "sendMessage") {
        sendMessagePayloads.push(payload as Record<string, unknown>);
        if ((payload as Record<string, unknown>).message_thread_id === 99) {
          return { ok: false, error_code: 400, description: "Bad Request: message thread not found" } as never;
        }
      }
      return prev(method, payload, signal);
    });

    const res = await env.bot.sendCommand(env.user, env.chat, "/help", { messageThreadId: 99 });

    expect(res.text).toContain("[Topic 99]");
    expect(res.text).toContain("Commands:");
    expect(sendMessagePayloads).toHaveLength(2);
    expect(sendMessagePayloads[0]?.message_thread_id).toBe(99);
    expect(sendMessagePayloads[1]?.message_thread_id).toBeUndefined();
  });

  it("ingests accepted text documents and passes an inline file block to the turn runner", async () => {
    const res = await env.bot.sendDocument(
      env.user,
      env.chat,
      {
        fileName: "notes.txt",
        mimeType: "text/plain",
        content: Buffer.from("alpha file content"),
      },
      { caption: "Please read this" },
    );

    expectRichCall(res, "Please read this");
    expectRichCall(res, "[[chat-file:");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "notes.txt", type: "txt", is_inline: 1 });
    expect(files[0]?.content_md).toBe("alpha file content");
    const rows = await env.repos.messages.listThread(thread.id);
    const userMessage = rows.find((row) => row.role === "user");
    expect(userMessage).toMatchObject({ kind: "file" });
    expect(files[0]?.message_id).toBe(userMessage?.id);
  });

  it("reuses the cached file when the same user sends the same document again", async () => {
    await env.dispose();
    let downloads = 0;
    env = await createGrammyEmulator({
      downloadFile: async ({ fileId }) => {
        downloads += 1;
        const content = env.bot.server.fileState.getFileContent(fileId);
        if (!content) throw new Error(`test file content not found: ${fileId}`);
        return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) };
      },
    });
    await startBot();

    const firstDoc = env.bot.server.fileState.storeDocument("reuse.txt", "text/plain", {
      content: Buffer.from("shared cached file content"),
    });
    const [first] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, firstDoc),
    ]);
    expectRichCall(first!, "[[chat-file:");

    const secondDoc = env.bot.server.fileState.storeDocument("reuse-again.txt", "text/plain", {
      content: Buffer.from("this should not be downloaded"),
    });
    secondDoc.file_unique_id = firstDoc.file_unique_id;
    const [second] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, secondDoc),
    ]);

    expect(downloads).toBe(1);
    expect(expectResponseSurface(second!)).toContain("Reused cached file <code>reuse-again.txt</code>.");
    expect(expectResponseSurface(second!)).not.toContain("Extracting <code>reuse-again.txt</code>");
    expectRichCall(second!, "reuse-again.txt");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const rows = await env.repos.messages.listThread(thread.id);
    const userMessages = rows.filter((row) => row.role === "user" && row.kind === "file");
    expect(userMessages).toHaveLength(2);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]?.content_md).toBe("shared cached file content");
    await expect(env.repos.files.listForMessage(userMessages[1]!.id)).resolves.toMatchObject([{ id: files[0]!.id }]);
  });

  it("reuses indexed content by hash when Telegram sends a different unique id", async () => {
    await env.dispose();
    let downloads = 0;
    env = await createGrammyEmulator({
      downloadFile: async ({ fileId }) => {
        downloads += 1;
        const content = env.bot.server.fileState.getFileContent(fileId);
        if (!content) throw new Error(`test file content not found: ${fileId}`);
        return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) };
      },
    });
    await startBot();

    const bytes = Buffer.from("hash fallback content");
    const firstDoc = env.bot.server.fileState.storeDocument("hash-a.txt", "text/plain", { content: bytes });
    const [first] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, firstDoc),
    ]);
    expectRichCall(first!, "[[chat-file:");

    const secondDoc = env.bot.server.fileState.storeDocument("hash-b.txt", "text/plain", { content: bytes });
    expect(secondDoc.file_unique_id).not.toBe(firstDoc.file_unique_id);
    const [second] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, secondDoc),
    ]);

    expect(downloads).toBe(2);
    expect(expectResponseSurface(second!)).toContain("Downloading <code>hash-b.txt</code>");
    expect(expectResponseSurface(second!)).toContain("Reused cached file <code>hash-b.txt</code>.");
    expect(expectResponseSurface(second!)).not.toContain("Extracting <code>hash-b.txt</code>");
    expectRichCall(second!, "hash-b.txt");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]?.content_md).toBe("hash fallback content");
  });

  it("does not extract a repeated docx when the content hash already exists", async () => {
    await env.dispose();
    env = await createGrammyEmulator({ config: { FILE_INLINE_TOKENS: 1 } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      document: {
        md_content: "# Report\n\nhash cached docx content ".repeat(20),
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await startBot();

    const bytes = Buffer.from("same fake docx bytes");
    const firstDoc = env.bot.server.fileState.storeDocument(
      "hash-report-a.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      { content: bytes },
    );
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, firstDoc),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const secondDoc = env.bot.server.fileState.storeDocument(
      "hash-report-b.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      { content: bytes },
    );
    expect(secondDoc.file_unique_id).not.toBe(firstDoc.file_unique_id);
    const [second] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, secondDoc),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expectResponseSurface(second!)).toContain("Reused cached file <code>hash-report-b.docx</code>.");
    expect(expectResponseSurface(second!)).not.toContain("Extracting <code>hash-report-b.docx</code>");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    const chunks = await env.repos.files.chunks(files[0]!.id);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("reuses the durable index while keeping one persistent original snapshot", async () => {
    await env.dispose();
    let downloads = 0;
    env = await createGrammyEmulator({
      config: { FILE_INLINE_TOKENS: 1 },
      downloadFile: async ({ fileId }) => {
        downloads += 1;
        const content = env.bot.server.fileState.getFileContent(fileId);
        if (!content) throw new Error(`test file content not found: ${fileId}`);
        return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) };
      },
    });
    await startBot();

    const bytes = Buffer.from("# Heading\n" + "restored cached path content ".repeat(40));
    const firstDoc = env.bot.server.fileState.storeDocument("restore-a.txt", "text/plain", { content: bytes });
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, firstDoc),
    ]);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [file] = await env.repos.files.listForThreads([thread.id]);
    const chunksBefore = await env.repos.files.chunks(file!.id);
    expect(chunksBefore.length).toBeGreaterThan(0);
    expect(file!.path).toBe(path.join(env.config.BASH_WORKSPACE_ROOT, ".chat-files", String(file!.id), "content"));

    const secondDoc = env.bot.server.fileState.storeDocument("restore-b.txt", "text/plain", { content: bytes });
    expect(secondDoc.file_unique_id).not.toBe(firstDoc.file_unique_id);
    const [second] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, secondDoc),
    ]);

    expect(downloads).toBe(2);
    expect(expectResponseSurface(second!)).toContain("Reused cached file <code>restore-b.txt</code>.");
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(file!.path);
    expect(await env.repos.files.listSources(file!.id)).toHaveLength(2);
    const chunksAfter = await env.repos.files.chunks(file!.id);
    expect(chunksAfter.map((chunk) => chunk.id)).toEqual(chunksBefore.map((chunk) => chunk.id));
  });

  it("reuses cached documents across users only after each user attaches the file", async () => {
    await env.dispose();
    let downloads = 0;
    env = await createGrammyEmulator({
      downloadFile: async ({ fileId }) => {
        downloads += 1;
        const content = env.bot.server.fileState.getFileContent(fileId);
        if (!content) throw new Error(`test file content not found: ${fileId}`);
        return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) };
      },
    });
    await startBot();
    const other = env.bot.createUser({ id: env.user.id + 300, first_name: "Bob", language_code: "en" });
    const otherChat = env.bot.createChat({ id: other.id, type: "private", first_name: "Bob" }) as typeof env.chat;
    await startBot(other, otherChat);

    const firstDoc = env.bot.server.fileState.storeDocument("global.txt", "text/plain", {
      content: Buffer.from("global cached document"),
    });
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, firstDoc),
    ]);
    const otherThreadBefore = await env.repos.threads.activeForUserTopic(other.id, null);
    expect(await env.repos.files.listForThreads([otherThreadBefore.id])).toHaveLength(0);

    const secondDoc = env.bot.server.fileState.storeDocument("global-copy.txt", "text/plain", {
      content: Buffer.from("unused copy"),
    });
    secondDoc.file_unique_id = firstDoc.file_unique_id;
    const [second] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(other, otherChat, secondDoc),
    ]);

    expect(downloads).toBe(1);
    expect(expectResponseSurface(second!)).toContain("Reused cached file <code>global-copy.txt</code>.");
    const ownerThread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const otherThread = await env.repos.threads.activeForUserTopic(other.id, null);
    const ownerFiles = await env.repos.files.listForThreads([ownerThread.id]);
    const otherFiles = await env.repos.files.listForThreads([otherThread.id]);
    expect(ownerFiles).toHaveLength(1);
    expect(otherFiles).toHaveLength(1);
    expect(otherFiles[0]?.id).toBe(ownerFiles[0]?.id);
  });

  it("refuses legacy .doc files before download", async () => {
    await startBot();
    const res = await env.bot.sendDocument(env.user, env.chat, {
      fileName: "legacy.doc",
      mimeType: "application/msword",
      content: Buffer.from("not docx"),
    });

    expect(res.text).toContain(".docx");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(await env.repos.files.listForThreads([thread.id])).toHaveLength(0);
  });

  it("replies to unsupported media instead of silently ignoring it", async () => {
    await startBot();
    const res = await env.bot.sendAudio(env.user, env.chat, { duration: 3, title: "voice memo" });

    expect(res.text).toContain("not supported");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(await env.repos.files.listForThreads([thread.id])).toHaveLength(0);
  });

  it("answers photos as image context without sending a processing response", async () => {
    await startBot();
    const res = await env.bot.sendPhoto(
      env.user,
      env.chat,
      { width: 640, height: 480, content: Buffer.from([1, 2, 3, 4]) },
      { caption: "whiteboard diagram" },
    );

    expect(expectResponseSurface(res)).not.toContain("processed");
    expectRichCall(res, "Echo:");
    expectRichCall(res, "whiteboard diagram");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files[0]).toMatchObject({ type: "image", is_inline: 1 });
    expect(files[0]?.summary).toBe("Telegram image");
    expect(files[0]?.path).toBe(path.join(env.config.BASH_WORKSPACE_ROOT, ".chat-files", String(files[0]?.id), "content"));
    const rows = await env.repos.messages.listThread(thread.id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const userMessage = rows.find((row) => row.role === "user");
    expect(userMessage).toMatchObject({ kind: "image" });
    expect(userMessage?.text_plain).toContain("whiteboard diagram");
    expect(userMessage?.text_plain).toContain("[image #");
    expect(files[0]?.message_id).toBe(userMessage?.id);
  });

  it("captions each newly uploaded image once", async () => {
    await env.dispose();
    const seenSizes: number[] = [];
    env = await createGrammyEmulator({
      imageCaptioner: {
        caption: async ({ bytes }) => {
          seenSizes.push(bytes.length);
          return "a sketched system diagram";
        },
      },
    });
    await startBot();
    const res = await env.bot.sendPhoto(env.user, env.chat, {
      width: 640,
      height: 480,
      content: Buffer.from([5, 6, 7, 8, 9]),
    });

    expect(seenSizes).toEqual([5]);
    expectRichCall(res, "Echo:");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [file] = await env.repos.files.listForThreads([thread.id]);
    expect(file?.summary).toBe("a sketched system diagram");
    expect(file?.path).toBe(path.join(env.config.BASH_WORKSPACE_ROOT, ".chat-files", String(file?.id), "content"));
  });

  it("does not expose one user's image caption when another user reuses the cached image", async () => {
    await startBot();
    const other = env.bot.createUser({ id: env.user.id + 400, first_name: "Bob", language_code: "en" });
    const otherChat = env.bot.createChat({ id: other.id, type: "private", first_name: "Bob" }) as typeof env.chat;
    await startBot(other, otherChat);

    const firstPhotos = env.bot.server.fileState.storePhoto(640, 480, {
      content: Buffer.from([1, 2, 3, 4]),
    });
    const firstLargest = [...firstPhotos].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]!;
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createPhotoMessage(env.user, env.chat, firstPhotos, {
        caption: "private caption alpha",
      }),
    ]);
    const ownerThread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [ownerFile] = await env.repos.files.listForThreads([ownerThread.id]);
    expect(ownerFile?.summary).toBe("Telegram image");

    const secondPhotos = env.bot.server.fileState.storePhoto(640, 480, {
      content: Buffer.from([9, 8, 7, 6]),
    });
    const secondLargest = [...secondPhotos].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]!;
    secondLargest.file_unique_id = firstLargest.file_unique_id;
    const [second] = await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createPhotoMessage(other, otherChat, secondPhotos, {
        caption: "bob caption beta",
      }),
    ]);

    expectRichCall(second!, "bob caption beta");
    expect(JSON.stringify(second!.apiCalls)).not.toContain("private caption alpha");
    const otherThread = await env.repos.threads.activeForUserTopic(other.id, null);
    const otherRows = await env.repos.messages.listThread(otherThread.id);
    expect(otherRows.find((row) => row.kind === "image")?.text_plain).toContain("bob caption beta");
    const [otherFile] = await env.repos.files.listForThreads([otherThread.id]);
    expect(otherFile?.id).toBe(ownerFile?.id);
    expect(otherFile?.summary).toBe("Telegram image");
  });

  it("chunks large text files into searchable file chunks", async () => {
    await env.dispose();
    env = await createGrammyEmulator({ config: { FILE_INLINE_TOKENS: 1 } });
    await startBot();
    const res = await env.bot.sendDocument(env.user, env.chat, {
      fileName: "big.txt",
      mimeType: "text/plain",
      content: Buffer.from("# Heading\nsearchable needle content in a longer file"),
    });

    expectRichCall(res, "Use search_in_file");
    expectRichCall(res, "Outline: Heading");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [file] = await env.repos.files.listForThreads([thread.id]);
    expect(file).toMatchObject({ name: "big.txt", is_inline: 0 });
    const chunks = await env.repos.files.chunks(file!.id);
    expect(chunks.length).toBeGreaterThan(0);
    const hits = await env.db.search.searchChunks([file!.id], "needle", 5);
    expect(hits[0]?.id).toBe(chunks[0]?.id);
  });

  it("shows editable file-processing status for accepted text files", async () => {
    await startBot();
    const res = await env.bot.sendDocument(env.user, env.chat, {
      fileName: "status.txt",
      mimeType: "text/plain",
      content: Buffer.from("status file content"),
    });

    expect(expectResponseSurface(res)).toContain("Downloading <code>status.txt</code>");
    expect(expectResponseSurface(res)).toContain("Extracting <code>status.txt</code>");
    expect(expectResponseSurface(res)).toContain("Indexing <code>status.txt</code>...\n100%");
    expect(expectResponseSurface(res)).toContain("File <code>status.txt</code> processed");
    expect(rawResponseSurface(res)).not.toMatch(/[\u2068\u2069]/u);
    expect(res.apiCalls.some((call) => call.payload.parse_mode === "HTML" && typeof call.payload.text === "string" && call.payload.text.includes("<code>status.txt</code>"))).toBe(true);
  });

  it("shows extraction and indexing status for docx-style long files", async () => {
    await env.dispose();
    env = await createGrammyEmulator({
      config: { FILE_INLINE_TOKENS: 1 },
      embedder: { embed: async (texts) => texts.map((text) => new Float32Array([text.length, 7])) },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      document: {
        md_content: "# Report\n\nsearchable docx content ".repeat(20),
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await startBot();

    const res = await env.bot.sendDocument(env.user, env.chat, {
      fileName: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: Buffer.from("fake docx bytes"),
    });

    expect(expectResponseSurface(res)).toContain("Downloading <code>report.docx</code>");
    expect(expectResponseSurface(res)).toContain("Extracting <code>report.docx</code>");
    expect(expectResponseSurface(res)).toContain("Indexing <code>report.docx</code>...\n100%");
    expect(expectResponseSurface(res)).toContain("Building vector index for <code>report.docx</code>...\n100%");
    expect(expectResponseSurface(res)).toContain("File <code>report.docx</code> processed");
  });

  it("keeps another user's thread responsive while a file is processing", async () => {
    await env.dispose();
    const started = deferred<void>();
    const release = deferred<void>();
    env = await createGrammyEmulator({
      downloadFile: async ({ signal }) => {
        started.resolve();
        await waitForRelease(release.promise, signal);
        return { bytes: Buffer.from("slow file content") };
      },
    });
    await startBot();
    const other = env.bot.createUser({ id: env.user.id + 200, first_name: "Bob", language_code: "en" });
    const otherChat = env.bot.createChat({ id: other.id, type: "private", first_name: "Bob" }) as typeof env.chat;
    await startBot(other, otherChat);

    const filePromise = env.bot.sendDocument(env.user, env.chat, {
      fileName: "slow.txt",
      mimeType: "text/plain",
      content: Buffer.from("unused"),
    });
    await started.promise;

    const otherRes = await env.bot.sendMessage(other, otherChat, "hello from another user");
    expectRichCall(otherRes, "Echo: hello from another user");

    release.resolve();
    await filePromise;
  }, 10_000);

  it("keeps another topic responsive for the same user while a file is processing", async () => {
    await env.dispose();
    const started = deferred<void>();
    const release = deferred<void>();
    env = await createGrammyEmulator({
      privateTopics: true,
      downloadFile: async ({ signal }) => {
        started.resolve();
        await waitForRelease(release.promise, signal);
        return { bytes: Buffer.from("topic slow file content") };
      },
    });
    await startBot();

    const topicDocument = env.bot.server.fileState.storeDocument("topic-slow.txt", "text/plain", {
      content: Buffer.from("unused"),
    });
    const topicUpdate = env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, topicDocument);
    topicUpdate.message!.message_thread_id = 41;
    const filePromise = env.bot.processUpdatesConcurrently([topicUpdate]);
    await started.promise;

    const otherTopicRes = await env.bot.sendMessage(env.user, env.chat, "hello from another topic", { messageThreadId: 42 });
    expectRichCall(otherTopicRes, "Echo: hello from another topic");

    release.resolve();
    await filePromise;
  }, 10_000);

  it("cancels active file processing in the current topic with /stop", async () => {
    await env.dispose();
    const started = deferred<void>();
    env = await createGrammyEmulator({
      downloadFile: async ({ signal }) => {
        started.resolve();
        await waitForAbort(signal);
        return { bytes: Buffer.from("should not be stored") };
      },
    });
    await startBot();

    const filePromise = env.bot.sendDocument(env.user, env.chat, {
      fileName: "cancel-me.txt",
      mimeType: "text/plain",
      content: Buffer.from("unused"),
    });
    await started.promise;

    const stop = await env.bot.sendCommand(env.user, env.chat, "/stop");
    expect(expectResponseSurface(stop)).toContain("Stopping file processing");
    const fileRes = await filePromise;
    expect(expectResponseSurface(fileRes)).toContain("File processing cancelled");

    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(await env.repos.files.listForThreads([thread.id])).toHaveLength(0);
    expect(await env.repos.messages.listThread(thread.id)).toHaveLength(0);
  }, 10_000);

  it("cancels a cached-file restoration without dispatching another user turn", async () => {
    await env.dispose();
    const restoreStarted = deferred<void>();
    let downloads = 0;
    env = await createGrammyEmulator({
      downloadFile: async ({ fileId, signal }) => {
        downloads += 1;
        if (downloads === 1) {
          const content = env.bot.server.fileState.getFileContent(fileId);
          if (!content) throw new Error(`test file content not found: ${fileId}`);
          return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) };
        }
        restoreStarted.resolve();
        await waitForAbort(signal);
        return { bytes: Buffer.from("cancelled restore must not complete") };
      },
    });
    await startBot();

    const document = env.bot.server.fileState.storeDocument("cached-cancel.txt", "text/plain", {
      content: Buffer.from("durable cached document content"),
    });
    await env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
    ]);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [file] = await env.repos.files.listForThreads([thread.id]);
    const messagesBefore = await env.repos.messages.listThread(thread.id);
    expect(file?.path).toBeTruthy();
    await fs.rm(file!.path!, { force: true });
    await fs.rm(env.config.FILE_CACHE_DIR, { recursive: true, force: true });
    await fs.mkdir(env.config.FILE_CACHE_DIR, { recursive: true, mode: 0o700 });

    const restorePromise = env.bot.processUpdatesConcurrently([
      env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
    ]);
    await restoreStarted.promise;

    const stop = await env.bot.sendCommand(env.user, env.chat, "/stop");
    expect(expectResponseSurface(stop)).toContain("Stopping file processing");
    const [restoreResponse] = await restorePromise;
    expect(expectResponseSurface(restoreResponse!)).toContain("File processing cancelled");
    expect(downloads).toBe(2);
    expect(await env.repos.messages.listThread(thread.id)).toHaveLength(messagesBefore.length);
  }, 10_000);

  it("does not cancel another topic's file processing with /stop", async () => {
    await env.dispose();
    const started = deferred<void>();
    const release = deferred<void>();
    env = await createGrammyEmulator({
      privateTopics: true,
      downloadFile: async ({ signal }) => {
        started.resolve();
        await waitForRelease(release.promise, signal);
        return { bytes: Buffer.from("different topic file content") };
      },
    });
    await startBot();

    const topicDocument = env.bot.server.fileState.storeDocument("keep-going.txt", "text/plain", {
      content: Buffer.from("unused"),
    });
    const topicUpdate = env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, topicDocument);
    topicUpdate.message!.message_thread_id = 51;
    const filePromise = env.bot.processUpdatesConcurrently([topicUpdate]);
    await started.promise;

    const stop = await env.bot.sendCommand(env.user, env.chat, "/stop", { messageThreadId: 52 });
    expect(stop.text).toContain("No active task");

    release.resolve();
    const [fileRes] = await filePromise;
    expect(fileRes).toBeDefined();
    expectRichCall(fileRes!, "[[chat-file:");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, 51);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]?.content_md).toBe("different topic file content");
  }, 10_000);

  it("processes Telegram media groups as one combined turn", async () => {
    await startBot();
    const document = env.bot.server.fileState.storeDocument("album.txt", "text/plain", {
      content: Buffer.from("album document content"),
    });
    const photos = env.bot.server.fileState.storePhoto(640, 480, {
      content: Buffer.from([9, 8, 7, 6]),
    });
    const docUpdate = env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document, {
      caption: "album caption",
    });
    const photoUpdate = env.bot.server.updateFactory.createPhotoMessage(env.user, env.chat, photos);
    docUpdate.message!.media_group_id = "album-1";
    photoUpdate.message!.media_group_id = "album-1";

    await env.bot.processUpdatesConcurrently([docUpdate, photoUpdate]);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const rows = await env.repos.messages.listThread(thread.id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0]).toMatchObject({ kind: "file" });
    expect(rows[0]?.text_plain).toContain("album caption");
    expect(rows[0]?.text_plain).toContain("[[chat-file:");
    expect(rows[0]?.text_plain).toContain("[image #");

    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(2);
    expect(files.find((file) => file.type === "txt")?.content_md).toContain("album document content");
    expect(new Set(files.map((file) => file.message_id))).toEqual(new Set([rows[0]?.id]));
    expect(rows[1]?.text_plain).toContain("album caption");
  });

  async function startBot(user = env.user, chat = env.chat): Promise<BotResponse> {
    return env.bot.sendCommand(user, chat, "/start");
  }
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T | PromiseLike<T>): void; reject(reason?: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: (value?: T | PromiseLike<T>) => resolve(value as T),
    reject,
  };
}

function piWithTitleGenerator(generateThreadTitle: PiRuntimeService["generateThreadTitle"]): PiRuntimeService {
  return {
    runtime: async () => { throw new Error("persistent Pi runtime is not used by this test"); },
    compact: async () => 0,
    fork: async () => undefined,
    captionImage: async () => "Telegram image",
    generateThreadTitle,
    abort: async () => false,
    dispose: async () => undefined,
  };
}

async function createTopic(
  env: GrammyEmulator,
  topicId: number,
  name: string,
  implicit: boolean,
): Promise<void> {
  const state = env.bot.server.chatState.get(env.chat.id);
  if (!state) throw new Error("test chat state is unavailable");
  state.forumTopics.set(topicId, {
    topic: { message_thread_id: topicId, name, icon_color: 0x6fb9f0 },
    isClosed: false,
    isPinned: false,
  });
  const update = env.bot.server.updateFactory.createForumTopicCreated(
    env.user,
    env.chat,
    { name, icon_color: 0x6fb9f0, ...(implicit ? { is_name_implicit: true as const } : {}) },
    topicId,
  );
  await env.bot.processUpdatesConcurrently([update]);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRelease(release: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    release.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
  });
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function expectRichCall(res: BotResponse, text: string): void {
  const call = res.getLastApiCall("sendRichMessage");
  expect(call).toBeDefined();
  expect(JSON.stringify(call?.payload)).toContain(text);
}

function expectResponseSurface(res: BotResponse): string {
  return normalizeFluent(rawResponseSurface(res));
}

function rawResponseSurface(res: BotResponse): string {
  return [
    ...res.texts,
    ...res.editedMessages.map((message) => "text" in message ? message.text ?? "" : ""),
    ...res.apiCalls.map((call) => typeof call.payload.text === "string" ? call.payload.text : ""),
  ].join("\n");
}

function normalizeFluent(text: string): string {
  return text.replace(/[\u2068\u2069]/g, "");
}
