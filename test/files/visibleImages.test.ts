import { serve } from "bun";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFinishResponseTool } from "../../src/ai/tools/finishResponse.js";
import { sendFinalVisible } from "../../src/ai/responseDelivery.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { FileResolver } from "../../src/files/resolver.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { sha256Hex } from "../../src/files/hash.js";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createWebRoutes } from "../../src/web/server.js";
import { createGrammyEmulator } from "../helpers/grammy-emulate.js";
import { fakeTelegramLogin, telegramLoginConfig } from "../helpers/telegram-login.js";
import { TEST_PNG } from "../helpers/workspaceRuntime.js";

async function setup() {
  const env = await createGrammyEmulator({ config: { WEB_ENABLED: true, ...telegramLoginConfig } });
  const user = await env.repos.users.ensure({ tgId: env.user.id, lang: "en" });
  const thread = await env.repos.threads.create({ userId: user.tg_id, topicId: null, title: "Pictures", origin: "web" });
  const original = await env.repos.messages.insert({ threadId: thread.id, role: "user", kind: "file", content: {}, textPlain: "Use this picture" });
  const file = await env.repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, type: "image",
    name: "original.png", mimeType: "image/png", size: TEST_PNG.length, contentSha256: sha256Hex(TEST_PNG), isInline: false });
  await env.repos.files.setMessageId(file.id, original.id);
  await env.repos.files.rememberSource(file.id, { transport: "e2b", connectionKey: env.config.E2B_DEPLOYMENT_ID, remoteKey: file.id, locator: {} });
  const sandboxRead = vi.fn(async () => TEST_PNG);
  env.services.fileResolver.registry.register({ transport: "e2b", connectionKey: env.config.E2B_DEPLOYMENT_ID, fetch: sandboxRead });
  const input = { config: env.config, db: env.db, repos: env.repos, user, thread, logger: env.services.logger,
    api: env.bot.api, chatId: user.tg_id, text: "Show this picture", t: (key: string) => key,
    fileResolver: env.services.fileResolver,
    resolveFile: env.services.fileResolver.resolveFile.bind(env.services.fileResolver) };
  const outgoingFiles = new OutgoingFiles(input);
  return { env, input, file, sandboxRead, outgoingFiles };
}

let fixture: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { fixture = await setup(); });
afterEach(async () => { await fixture.outgoingFiles.dispose(); await fixture.env.dispose(); });

const visual = (id: string, kind: "gallery" | "thumbnail") => kind === "gallery"
  ? `root = Stack([picture])\npicture = Image("file:${id}","Saved picture","")`
  : `root = Stack([ItemList("Choices",[Item("One","file:${id}",[],"A suitable choice",[])])])`;

it.each(["gallery", "thumbnail"] as const)("retains a reused %s before completion and serves it after restart without any sandbox read", async kind => {
  const { env, input, file, outgoingFiles, sandboxRead } = fixture;
  const openui = visual(file.id, kind);
  const result = await createFinishResponseTool({ ...input, outgoingFiles, responseDraft: { text: "" } })
    .execute({ text: "Here is the picture.", openui });
  expect(result).toMatchObject({ completed: true });
  expect(sandboxRead).toHaveBeenCalledOnce();
  sandboxRead.mockRejectedValue(new Error("Sandbox no longer exists"));
  await sendFinalVisible(input, "", "Here is the picture.", 0, [], undefined, undefined, { openui });
  expect(sandboxRead).toHaveBeenCalledOnce();
  const restarted = new FileResolver(env.repos.files, undefined, new LocalFileStore(env.config.FILE_STORAGE_PATH));
  const forbidden = vi.fn(async () => { throw new Error("A website read must not touch the sandbox"); });
  restarted.registry.register({ transport: "e2b", connectionKey: env.config.E2B_DEPLOYMENT_ID, fetch: forbidden });
  const repository = new ConversationRepository(env.db.db, env.repos, 99);
  const chat = new BotChatService({ services: env.services, api: env.bot.api, repository });
  const login = await fakeTelegramLogin();
  const controller = new AbortController();
  const routes = createWebRoutes({ config: env.config, access: env.services.access, repository,
    chat: { service: chat, botUsername: "test_bot" }, telegramAuth: login.dependencies,
    fileResolver: restarted, logger: env.services.logger }, controller.signal);
  const server = serve({ hostname: "127.0.0.1", port: 0, routes: routes.routes, fetch: routes.fetch });
  try {
    const cookie = await login.signIn(server.url, input.user.tg_id);
    for (const mode of ["auto", "download"]) {
      const response = await fetch(new URL(`/api/chat/threads/${input.thread.id}/files/${file.id}?mode=${mode}`, server.url), {
        headers: { Cookie: cookie, "X-Chat-User": String(input.user.tg_id) },
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(TEST_PNG);
    }
    expect(forbidden).not.toHaveBeenCalled();
  } finally { controller.abort(); await server.stop(true); await routes.drain(); }
});

it("rejects a picture outside the thread before downloading it", async () => {
  const { env, input, file, outgoingFiles, sandboxRead } = fixture;
  const thread = await env.repos.threads.create({ userId: input.user.tg_id, topicId: null, title: "Separate", origin: "web" });
  const result = await createFinishResponseTool({ ...input, thread, outgoingFiles, responseDraft: { text: "" } })
    .execute({ text: "Picture", openui: visual(file.id, "gallery") });
  expect(result).toMatchObject({ completed: false, error: expect.stringContaining("not available in this conversation") });
  expect(sandboxRead).not.toHaveBeenCalled();
});

it("keeps an unavailable visual out of the published answer and lets the model repair it", async () => {
  const { input, file, outgoingFiles, sandboxRead } = fixture;
  sandboxRead.mockRejectedValue(new Error("Source expired"));
  const openui = visual(file.id, "gallery");
  const result = await createFinishResponseTool({ ...input, outgoingFiles, responseDraft: { text: "" } })
    .execute({ text: "Picture", openui });
  expect(result).toMatchObject({ completed: false });
  await expect(sendFinalVisible(input, "", "Picture", 0, [], undefined, undefined, { openui })).rejects.toThrow();
  expect((await input.repos.messages.listThread(input.thread.id)).filter(message => message.role === "assistant")).toEqual([]);
});
