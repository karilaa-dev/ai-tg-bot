import { serve, type Server } from "bun";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError, InputFile } from "grammy";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { sendFinal, sendFinalVisible } from "../../src/ai/responseDelivery.js";
import { createCreateFileTool } from "../../src/ai/tools/createFile.js";
import { E2BFileSourceAdapter } from "../../src/e2b/fileSource.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository, WebNotFound } from "../../src/web/repository.js";
import { createWebRoutes } from "../../src/web/server.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { fakeTelegramLogin, telegramLoginConfig } from "../helpers/telegram-login.js";
import { TEST_PNG, workspaceRuntime } from "../helpers/workspaceRuntime.js";
import { FilesRepo } from "../../src/db/repos/files.js";
import { MessagesRepo } from "../../src/db/repos/messages.js";

const telegram = fakeTelegramLogin();
// The emulator's Telegram user, who has started the bot.
const ADMIN_ID = 1001;

describe.each(["workspace", "bytes", "spooled bytes"])("saved assistant %s files across Telegram delivery outcomes", source => {
  const csv = Buffer.from("name,total\nAlice,42\n");
  const answer = "Here is the generated report.";
  let env: GrammyEmulator;
  let chat: BotChatService;
  let repository: ConversationRepository;
  let server: Server<undefined>;
  let routes: ReturnType<typeof createWebRoutes>;
  let controller: AbortController;
  let cookie: string;
  let generatedFileId: string;
  let runs: number;

  beforeEach(async () => {
    runs = 0;
    const runtime = workspaceRuntime();
    runtime.put("/report.csv", csv);
    runtime.readSourceFile.mockResolvedValue(csv);
    env = await createGrammyEmulator({
      privateTopics: true,
      config: { ...telegramLoginConfig, WEB_ADMIN_USER_IDS: [ADMIN_ID] },
      turnRunner: async input => {
        runs++;
        const files = new OutgoingFiles({ ...input, commandRuntime: runtime });
        try {
          if (source === "workspace") {
            const result = await files.workspace([{ path: "/report.csv", mime: "text/csv" }]);
            expect(result.errors).toEqual([]);
          } else {
            await files.bytes(async () => ({ bytes: csv, name: "report.csv", mime: "text/csv" }));
          }
          const attachment = files.items[0];
          if (!attachment) throw new Error("The report was not generated.");
          generatedFileId = attachment.fileId;
          if (source === "spooled bytes") files.buffers.release(attachment);
          await sendFinal({ ...input, outgoingBuffers: files.buffers }, "", answer, 0, files.items);
        } finally {
          await files.dispose();
        }
      },
    });
    env.services.fileResolver.registry.register(new E2BFileSourceAdapter(env.config, runtime));
    await env.bot.sendCommand(env.user, env.chat, "/start");
    repository = new ConversationRepository(env.db.db, env.repos, 999);
    chat = new BotChatService({ services: env.services, repository, api: env.bot.api });
    controller = new AbortController();
    const login = await telegram;
    routes = createWebRoutes({ db: env.db.db, config: env.config, access: env.services.access, repository, chat: { service: chat, botUsername: "test_bot" }, telegramAuth: login.dependencies,
      fileResolver: env.services.fileResolver, logger: env.services.logger }, controller.signal);
    server = serve({ hostname: "127.0.0.1", port: 0, development: false, routes: routes.routes, fetch: routes.fetch });
    cookie = await login.signIn(server.url, ADMIN_ID);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    controller?.abort();
    await server?.stop(true);
    await routes?.drain();
    await env?.dispose();
  });

  it("still removes unreturned output during turn cleanup", async () => {
    const user = await env.repos.users.ensure({ tgId: env.user.id });
    const thread = await env.repos.threads.create({ userId: user.tg_id, topicId: null, title: "Draft" });
    const runtime = workspaceRuntime();
    runtime.put("/report.csv", csv);
    const files = new OutgoingFiles({ config: env.config, repos: env.repos, user, thread, commandRuntime: runtime });
    try {
      if (source === "workspace") {
        expect((await files.workspace([{ path: "/report.csv", mime: "text/csv" }])).errors).toEqual([]);
      } else {
        await files.bytes(async () => ({ bytes: csv, name: "report.csv", mime: "text/csv" }));
      }
      const attachment = files.items[0];
      if (!attachment) throw new Error("The draft was not generated.");
      if (source === "spooled bytes") files.buffers.release(attachment);
      expect(await env.repos.files.get(attachment.fileId)).toMatchObject({ message_id: null });
      await files.dispose();
      expect(await env.repos.files.get(attachment.fileId)).toBeUndefined();
      expect((await chat.history(user.tg_id, thread.id)).messages).toEqual([]);
    } finally {
      await files.dispose();
    }
  });

  it.each(["blocked", "upload rejected", "delivered"])(
    "keeps generated CSV history and download access after cleanup when Telegram is %s",
    async outcome => {
      const thread = await chat.createThread(env.user.id, "Generated report");
      const before = await env.repos.messages.insert({ threadId: thread.id, role: "user",
        content: { text: "Before the report" }, textPlain: "Before the report" });
      const fork = await env.repos.threads.create({ userId: env.user.id, topicId: null,
        title: "Earlier fork", parentThreadId: thread.id, forkPointMessageId: before.id });
      const unrelated = await env.repos.threads.create({ userId: env.user.id, topicId: null, title: "Other chat" });
      if (source === "spooled bytes" && outcome === "blocked") {
        vi.spyOn(FilesRepo.prototype, "setMessageId").mockRejectedValueOnce(new Error("Temporary association write failure"));
      }
      const sends: string[] = [];
      const uploads: unknown[] = [];
      env.bot.api.config.use((previous, method, payload, signal) => {
        if (method.startsWith("send")) sends.push(method);
        if (method === "sendDocument") uploads.push(payload);
        if ((outcome === "blocked" && method.startsWith("send"))
          || (outcome === "upload rejected" && method === "sendDocument")) {
          throw new GrammyError("blocked", { ok: false, error_code: 403,
            description: "Forbidden: bot was blocked by the user" }, method, payload);
        }
        return previous(method, payload, signal);
      });
      const request = { text: "Generate a CSV", requestId: randomUUID() };
      const sent = await chat.send(env.user.id, thread.id, request);
      const echo = await env.repos.messages.get(sent.messageId);
      for (const payload of uploads) expect(payload).toMatchObject({
        disable_notification: true, reply_parameters: { message_id: echo?.tg_message_id, allow_sending_without_reply: true },
      });
      const history = await chat.history(env.user.id, thread.id);
      const assistant = history.messages.at(-1);
      expect(assistant).toMatchObject({ role: "assistant", text: answer,
        attachments: [{ id: generatedFileId, name: "report.csv", mimeType: "text/csv" }] });
      expect(assistant?.attachments).toHaveLength(1);
      expect(await env.repos.files.get(generatedFileId)).toMatchObject({ message_id: assistant?.id });
      const download = await fetch(new URL(`/api/threads/${thread.id}/files/${generatedFileId}?mode=download`, server.url), {
        headers: { Cookie: cookie },
      });
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Disposition")).toContain("report.csv");
      expect(Buffer.from(await download.arrayBuffer())).toEqual(csv);
      for (const hidden of [fork, unrelated]) {
        await expect(repository.file(hidden.id, generatedFileId)).rejects.toBeInstanceOf(WebNotFound);
        expect((await chat.history(env.user.id, hidden.id)).messages.flatMap(message => message.attachments)).toEqual([]);
      }
      const sources = await env.repos.files.listSources(generatedFileId);
      expect(sources.some(saved => saved.transport === (source === "workspace" ? "e2b" : "local"))).toBe(true);
      expect(sources.some(saved => saved.transport === "telegram")).toBe(outcome === "delivered");
      if (source === "spooled bytes" && outcome === "blocked") {
        expect(FilesRepo.prototype.setMessageId).toHaveBeenCalledTimes(2);
      }
      expect(sends.filter(method => method === "sendDocument")).toHaveLength(outcome === "blocked" ? 0 : 1);
      expect((await env.repos.turnRuns.get(sent.turnId))?.status).toBe(outcome === "blocked" ? "failed" : "succeeded");
      expect((await chat.send(env.user.id, thread.id, request)).turnId).toBe(sent.turnId);
      expect(runs).toBe(1);
      expect((await chat.history(env.user.id, thread.id)).messages).toHaveLength(3);
    },
  );
});

describe.each([false, true])("workspace photos with OpenUI=%s", withOpenUi => {
  const answer = "Here is the photo.";
  let env: GrammyEmulator;
  let chat: BotChatService;
  let repository: ConversationRepository;
  let server: Server<undefined>;
  let routes: ReturnType<typeof createWebRoutes>;
  let controller: AbortController;
  let cookie: string;
  let generatedFileId: string;
  let openui: string | undefined;
  let disposed: boolean;
  let runtime: ReturnType<typeof workspaceRuntime>;
  const checkpoints: Array<{ name: string; history: ReturnType<BotChatService["history"]> }> = [];

  beforeEach(async () => {
    disposed = false;
    checkpoints.length = 0;
    runtime = workspaceRuntime();
    runtime.put("/photo.png", TEST_PNG);
    env = await createGrammyEmulator({
      privateTopics: true,
      config: { ...telegramLoginConfig, WEB_ADMIN_USER_IDS: [ADMIN_ID] },
      turnRunner: async input => {
        const files = new OutgoingFiles({ ...input, commandRuntime: runtime });
        const checkpoint = (name: string) => {
          checkpoints.push({ name, history: chat.history(input.user.tg_id, input.thread.id) });
        };
        try {
          const created = await createCreateFileTool({ ...input, outgoingFiles: files }).execute({
            path: "/photo.png", mime: "image/png", delivery: "auto", caption: "A saved photo",
          });
          if (!("file_id" in created)) throw new Error("create_file did not create the photo.");
          generatedFileId = created.file_id;
          openui = withOpenUi ? `root = Stack([Image("file:${generatedFileId}","A saved photo","")])` : undefined;
          await sendFinalVisible({ ...input, outgoingBuffers: files.buffers,
            onAwaitingDelivery: async result => {
              await Promise.all(checkpoints.map(checkpoint => checkpoint.history));
              await input.onAwaitingDelivery?.(result);
              checkpoint("awaiting delivery");
              await checkpoints.at(-1)?.history;
            },
            onDeliveryConfirmed: async result => {
              checkpoint("confirmed");
              await checkpoints.at(-1)?.history;
              await input.onDeliveryConfirmed?.(result);
            },
            onDeliveryFailed: async result => {
              checkpoint("failed");
              await checkpoints.at(-1)?.history;
              await input.onDeliveryFailed?.(result);
            },
          }, "", answer, 0, files.items, undefined, undefined, { openui }, () => checkpoint("persisted"));
        } finally {
          await files.dispose();
          disposed = true;
        }
      },
    });
    env.services.fileResolver.registry.register(new E2BFileSourceAdapter(env.config, runtime));
    await env.bot.sendCommand(env.user, env.chat, "/start");
    repository = new ConversationRepository(env.db.db, env.repos, 999);
    chat = new BotChatService({ services: env.services, repository, api: env.bot.api });
    controller = new AbortController();
    const login = await telegram;
    routes = createWebRoutes({ db: env.db.db, config: env.config, access: env.services.access, repository, chat: { service: chat, botUsername: "test_bot" }, telegramAuth: login.dependencies,
      fileResolver: env.services.fileResolver, logger: env.services.logger }, controller.signal);
    server = serve({ hostname: "127.0.0.1", port: 0, development: false, routes: routes.routes, fetch: routes.fetch });
    cookie = await login.signIn(server.url, ADMIN_ID);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    controller?.abort();
    await server?.stop(true);
    await routes?.drain();
    await env?.dispose();
  });

  it.each(["blocked", "upload rejected", "upload unknown", "delivered", "final write failed", "blocked and final write failed"])(
    "publishes a recoverable photo after Telegram is %s", async outcome => {
      const thread = await chat.createThread(env.user.id, "Photos");
      const before = await env.repos.messages.insert({ threadId: thread.id, role: "user",
        content: { text: "Before the photo" }, textPlain: "Before the photo" });
      const fork = await env.repos.threads.create({ userId: env.user.id, topicId: null,
        title: "Earlier fork", parentThreadId: thread.id, forkPointMessageId: before.id });
      const unrelated = await env.repos.threads.create({ userId: env.user.id, topicId: null, title: "Other chat" });
      const finalWriteFailed = outcome.includes("final write failed");
      const blocked = outcome.startsWith("blocked");
      if (finalWriteFailed) {
        const setContent = MessagesRepo.prototype.setDeliveryContent;
        vi.spyOn(MessagesRepo.prototype, "setDeliveryContent").mockImplementation(async function (this: MessagesRepo, input) {
          if ((await this.get(input.messageId))?.role === "assistant") throw new Error("Final content write unavailable");
          return setContent.call(this, input);
        });
      }
      const rememberPhoto = env.repos.files.rememberTelegramObservation.bind(env.repos.files);
      vi.spyOn(env.repos.files, "rememberTelegramObservation").mockImplementation(async (...args) => {
        checkpoints.push({ name: "storing photo", history: chat.history(env.user.id, thread.id) });
        await checkpoints.at(-1)?.history;
        return rememberPhoto(...args);
      });
      const uploads: unknown[] = [];
      env.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === "sendPhoto" || method === "sendDocument") {
          uploads.push(payload);
          checkpoints.push({ name: "uploading", history: chat.history(env.user.id, thread.id) });
          await checkpoints.at(-1)?.history;
          const stored = await env.repos.files.get(generatedFileId);
          expect(stored?.message_id).toBeTypeOf("number");
          expect((await env.repos.files.listSources(generatedFileId)).some(source => source.transport === "e2b")).toBe(true);
        }
        if (outcome === "upload unknown" && method === "sendPhoto") throw new Error("Connection reset after upload");
        if ((blocked && method.startsWith("send"))
          || (outcome === "upload rejected" && (method === "sendPhoto" || method === "sendDocument"))) {
          throw new GrammyError("blocked", { ok: false, error_code: 403,
            description: "Forbidden: bot was blocked by the user" }, method, payload);
        }
        const response = await previous(method, payload, signal);
        if (method === "sendPhoto") {
          if (!("photo" in payload) || !(payload.photo instanceof InputFile)) throw new Error("Expected photo bytes.");
          const bytes = await payload.photo.toRaw();
          if (!(bytes instanceof Uint8Array)) throw new Error("Expected a buffered photo.");
          expect(Buffer.from(bytes)).toEqual(TEST_PNG);
          const sentPhoto = z.object({ ok: z.literal(true), result: z.object({ photo: z.array(z.object({
            file_id: z.string(), file_unique_id: z.string(),
          })) }) }).parse(response);
          // The emulator acknowledges uploads but does not store their contents.
          for (const photo of sentPhoto.result.photo) env.bot.server.fileState.storeFile("photo", {
            fileId: photo.file_id, fileUniqueId: photo.file_unique_id, content: bytes,
          });
        }
        return response;
      });
      const sent = await chat.send(env.user.id, thread.id, { text: "Find and send a photo", requestId: randomUUID() });
      expect(disposed).toBe(true);
      for (const checkpoint of checkpoints) {
        const assistant = (await checkpoint.history).messages.at(-1);
        expect(assistant?.role).toBe("assistant");
        expect(assistant?.text).toBe(answer);
        if (["persisted", "awaiting delivery", "uploading", "storing photo"].includes(checkpoint.name)
          || (finalWriteFailed && checkpoint.name === "failed")) {
          expect(assistant?.openui).toBeUndefined();
          expect(assistant?.attachments).toEqual([]);
        } else {
          expect(assistant?.openui).toBe(openui);
          expect(assistant?.attachments).toHaveLength(1);
        }
      }
      expect(checkpoints.map(checkpoint => checkpoint.name).slice(0, 2)).toEqual(["persisted", "awaiting delivery"]);
      const assistant = (await chat.history(env.user.id, thread.id)).messages.at(-1);
      expect(assistant).toMatchObject({ role: "assistant", text: answer,
        attachments: [{ id: generatedFileId, name: "photo.png", kind: "image", mimeType: "image/png" }] });
      expect(assistant?.openui).toBe(openui);
      const sources = await env.repos.files.listSources(generatedFileId);
      const delivered = outcome === "delivered" || outcome === "final write failed";
      expect(sources.some(source => source.transport === "telegram")).toBe(delivered);
      const photoRefs = await env.repos.files.listTelegramFileRefs([generatedFileId]);
      if (delivered) {
        expect(photoRefs).not.toHaveLength(0);
        expect(photoRefs.every(ref => ref.media_kind === "photo" && ref.direction === "outbound")).toBe(true);
        expect(photoRefs.some(ref => ref.is_primary === 1)).toBe(true);
        expect(checkpoints.some(checkpoint => checkpoint.name === "storing photo")).toBe(true);
      } else expect(photoRefs).toEqual([]);
      expect(uploads).toHaveLength(blocked ? 0 : outcome === "upload rejected" ? 2 : 1);
      const echo = await env.repos.messages.get(sent.messageId);
      for (const payload of uploads) expect(payload).toMatchObject({ disable_notification: true,
        reply_parameters: { message_id: echo?.tg_message_id, allow_sending_without_reply: true } });
      const download = await fetch(new URL(`/api/threads/${thread.id}/files/${generatedFileId}?mode=auto`, server.url), {
        headers: { Cookie: cookie },
      });
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Type")).toBe("image/png");
      expect(download.headers.get("Content-Disposition")).toMatch(/^inline;/);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(TEST_PNG);
      if (delivered) expect(runtime.readSourceFile).not.toHaveBeenCalled();
      for (const hidden of [fork, unrelated]) {
        await expect(repository.file(hidden.id, generatedFileId)).rejects.toBeInstanceOf(WebNotFound);
        expect((await chat.history(env.user.id, hidden.id)).messages.flatMap(message => message.attachments)).toEqual([]);
        const hiddenDownload = await fetch(new URL(`/api/threads/${hidden.id}/files/${generatedFileId}?mode=auto`, server.url), {
          headers: { Cookie: cookie },
        });
        expect(hiddenDownload.status).toBe(404);
      }
      if (blocked) expect((await env.repos.turnRuns.get(sent.turnId))?.status).toBe("failed");
      if (finalWriteFailed) {
        await env.db.db.execute(sql`update turn_runs set status = 'awaiting_delivery', lease_expires_at = ${Date.now() + 60_000} where id = ${sent.turnId}`);
        expect((await chat.history(env.user.id, thread.id)).messages.at(-1)?.attachments).toEqual([]);
        await env.db.db.execute(sql`update turn_runs set lease_expires_at = ${Date.now() - 1} where id = ${sent.turnId}`);
        expect((await chat.history(env.user.id, thread.id)).messages.at(-1)?.attachments).toHaveLength(1);
        expect((await chat.history(env.user.id, thread.id)).messages.at(-1)?.openui).toBe(openui);
      }
    },
  );
});
