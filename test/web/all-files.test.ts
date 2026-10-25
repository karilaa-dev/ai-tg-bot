import { serve, type Server } from "bun";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { GrammyError, InputFile } from "grammy";
import { z } from "zod";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createWebRoutes } from "../../src/web/server.js";
import { MAX_CHAT_BODY_BYTES } from "../../src/web/chat-routes.js";
import { MAX_FILE_BYTES } from "../../src/files/limits.js";
import { resolveThreadFileDescriptors } from "../../src/e2b/threadFiles.js";
import type { StoredFileType } from "../../src/db/types.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { TEST_PNG } from "../helpers/workspaceRuntime.js";

const binary = Buffer.from([0, 0xff, 0x80, 1, 2, 3]);
const opaque = [
  { name: "archive.zip", mime: "application/zip", bytes: Buffer.concat([Buffer.from("PK\x03\x04"), binary]) },
  { name: "clip.mp4", mime: "video/mp4", bytes: Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex") },
  { name: "program.exe", mime: "application/x-msdownload", bytes: Buffer.concat([Buffer.from("MZ"), binary]) },
  { name: "legacy.doc", mime: "application/msword", bytes: Buffer.from("d0cf11e0a1b11ae100ff", "hex") },
  { name: "legacy.xls", mime: "application/vnd.ms-excel", bytes: binary },
  { name: "legacy.ppt", mime: "application/vnd.ms-powerpoint", bytes: binary },
  { name: "unknown.custom", mime: "", bytes: binary },
].map(file => ({ ...file, type: "other" as const }));
const rich: Array<{ name: string; mime: string; bytes: Buffer; type: StoredFileType }> = [
  { name: "notes.txt", mime: "text/plain", bytes: Buffer.from("Hello, Привет"), type: "txt" },
  { name: "table.csv", mime: "text/csv", bytes: Buffer.from("name,value\nAlice,42\n"), type: "csv" },
  { name: "report.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.7\n%%EOF"), type: "pdf" },
  { name: "report.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: Buffer.concat([Buffer.from("PK\x03\x04"), binary]), type: "docx" },
  { name: "photo.png", mime: "image/png", bytes: TEST_PNG, type: "image" },
  { name: "recording.mp3", mime: "audio/mpeg", bytes: Buffer.concat([Buffer.from("ID3"), binary]), type: "audio" },
];
const originalFetch = globalThis.fetch;
const publicOrigin = "https://all-files.example";
const acceptedSchema = z.object({ turnId: z.number(), messageId: z.number() });

describe("all file formats through HTTP, storage, and Telegram", () => {
  let env: GrammyEmulator;
  let chat: BotChatService;
  let server: Server<undefined>;
  let controller: AbortController;
  let routes: ReturnType<typeof createWebRoutes>;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: Awaited<ReturnType<typeof exportJWK>>;
  let nonce = "";
  let identity = 1001;
  let cookie: string;
  let rejectDocuments: boolean;
  let uploaded: Array<{ name: string | undefined; bytes: Buffer; payload: unknown }>;
  const request = (pathname: string, init?: RequestInit) => originalFetch(new URL(pathname, server.url), { redirect: "manual", ...init });
  const cookieValue = (response: Response, prefix: string) => response.headers.getSetCookie().find(value => value.startsWith(prefix))!.split(";")[0]!;
  const headers = () => ({ Cookie: cookie, "X-Chat-User": String(env.user.id), "X-Chat-Request": "1", Origin: publicOrigin });

  async function login(userId = env.user.id) {
    const start = await request("/api/auth/telegram/start");
    const location = new URL(start.headers.get("Location")!);
    nonce = location.searchParams.get("nonce")!;
    identity = userId;
    const response = await request(`/api/auth/telegram/callback?code=local&state=${location.searchParams.get("state")}`, {
      headers: { Cookie: cookieValue(start, "__Host-ai_tg_bot_chat_login=") },
    });
    expect(response.status).toBe(303);
    return cookieValue(response, "__Host-ai_tg_bot_chat_session=");
  }

  async function upload(threadId: number, files: Array<{ name: string; mime: string; bytes: Buffer }>, requestId = randomUUID()) {
    const form = new FormData();
    form.set("text", "Keep these exact files");
    form.set("requestId", requestId);
    for (const file of files) form.append("files", new File([new Uint8Array(file.bytes)], file.name, { type: file.mime }));
    return request(`/api/chat/threads/${threadId}/messages`, { method: "POST", headers: headers(), body: form });
  }

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    jwk = { ...await exportJWK(keys.publicKey), kid: "all-files-local", alg: "RS256" };
  });
  beforeEach(async () => {
    rejectDocuments = false;
    uploaded = [];
    env = await createGrammyEmulator({ privateTopics: true, config: {
      WEB_ENABLED: true, WEB_TELEGRAM_CLIENT_ID: "123", WEB_TELEGRAM_CLIENT_SECRET: "local-test-secret",
      WEB_PUBLIC_URL: publicOrigin, WEB_PORT: 0, WEB_AUTOLOAD_MAX_BYTES: MAX_FILE_BYTES,
    } });
    await env.bot.sendCommand(env.user, env.chat, "/start");
    const repository = new ConversationRepository(env.db.db, env.repos, 999);
    chat = new BotChatService({ services: env.services, repository, api: env.bot.api });
    env.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendDocument" && "document" in payload) {
        if (!(payload.document instanceof InputFile)) throw new Error("Expected an uploaded document.");
        const raw = await payload.document.toRaw();
        if (!(raw instanceof Uint8Array)) throw new Error("Expected buffered bytes.");
        uploaded.push({ name: payload.document.filename, bytes: Buffer.from(raw), payload });
        if (rejectDocuments) throw new GrammyError("rejected", { ok: false, error_code: 403, description: "Forbidden: local test rejection" }, method, payload);
      }
      return previous(method, payload, signal);
    });
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth.telegram.org/.well-known/jwks.json") return Response.json({ keys: [jwk] });
      if (url === "https://oauth.telegram.org/token") return Response.json({ id_token: await new SignJWT({ id: identity, nonce })
        .setProtectedHeader({ alg: "RS256", kid: "all-files-local" }).setIssuer("https://oauth.telegram.org")
        .setAudience("123").setSubject(String(identity)).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey) });
      throw new Error("External network is disabled in this test.");
    });
    controller = new AbortController();
    routes = createWebRoutes({ config: env.config, repository, chat: { service: chat, botUsername: "ai_test_bot" },
      fileResolver: env.services.fileResolver, logger: env.services.logger }, controller.signal);
    server = serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_CHAT_BODY_BYTES, routes: routes.routes, fetch: routes.fetch });
    cookie = await login();
  });
  afterEach(async () => {
    controller?.abort();
    await server?.stop(true);
    await routes?.drain();
    vi.unstubAllGlobals();
    await env?.dispose();
  });

  it.each([{ label: "opaque", files: opaque }, { label: "rich", files: rich }])("uploads, mirrors, and privately downloads $label formats byte for byte", async ({ files }) => {
    const thread = await chat.createThread(env.user.id, "Formats");
    const before = await env.repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Before uploads" });
    const fork = await env.repos.threads.create({ userId: env.user.id, title: "Earlier fork", topicId: null, parentThreadId: thread.id, forkPointMessageId: before.id });
    const unrelated = await env.repos.threads.create({ userId: env.user.id, title: "Unrelated", topicId: null });
    const response = await upload(thread.id, files);
    expect(response.status).toBe(202);
    const accepted = acceptedSchema.parse(await response.json());
    expect((await env.repos.turnRuns.get(accepted.turnId))?.status).toBe("succeeded");
    const stored = await env.repos.files.listForThreads([thread.id]);
    expect(stored).toHaveLength(files.length);
    expect(uploaded).toHaveLength(files.length);
    // Disable Telegram retrieval so downloads must use the persisted web source.
    env.services.fileResolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => { throw new Error("Telegram offline"); } });
    for (const sample of files) {
      const file = stored.find(item => item.name === sample.name)!;
      expect(file).toMatchObject({ user_id: env.user.id, thread_id: thread.id, message_id: accepted.messageId, type: sample.type, size: sample.bytes.length });
      if (sample.type === "other") {
        expect(file).toMatchObject({ extraction_status: "source_only", content_md: null, is_inline: 0 });
        expect(await env.repos.files.chunks(file.id)).toEqual([]);
      }
      expect(await env.repos.files.listSources(file.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ transport: "web", remote_key: String(file.id), locator_json: "{}" }),
        expect.objectContaining({ transport: "telegram" }),
      ]));
      expect(uploaded.find(item => item.name === sample.name)).toMatchObject({ bytes: sample.bytes,
        payload: { message_thread_id: thread.topicId, disable_notification: true } });
      const download = await request(`/api/chat/threads/${thread.id}/files/${file.id}`, { headers: headers() });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(sample.bytes);
      expect(download.headers.get("Content-Disposition")).toContain("attachment");
      expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
      for (const outside of [fork, unrelated]) expect((await request(`/api/chat/threads/${outside.id}/files/${file.id}`, { headers: headers() })).status).toBe(404);
    }
    const descriptors = await resolveThreadFileDescriptors({ repos: env.repos, thread: (await env.repos.threads.get(thread.id))! });
    expect(descriptors.map(file => file.fileId).sort()).toEqual(stored.map(file => file.id).sort());
    await env.repos.users.ensure({ tgId: 2002, firstName: "Other" });
    const otherCookie = await login(2002);
    expect((await request(`/api/chat/threads/${thread.id}/files/${stored[0]!.id}`, { headers: { ...headers(), Cookie: otherCookie, "X-Chat-User": "2002" } })).status).toBe(404);
  });

  it("keeps failed Telegram mirrors downloadable, materializable, and idempotent", async () => {
    const thread = await chat.createThread(env.user.id, "Telegram unavailable");
    rejectDocuments = true;
    const requestId = randomUUID();
    const response = await upload(thread.id, opaque.slice(0, 2), requestId);
    expect(response.status).toBe(202);
    const accepted = acceptedSchema.parse(await response.json());
    const retry = await upload(thread.id, opaque.slice(0, 2), requestId);
    expect(acceptedSchema.parse(await retry.json())).toEqual(accepted);
    expect(uploaded).toHaveLength(1);
    expect((await env.repos.turnRuns.get(accepted.turnId))?.status).toBe("succeeded");
    const history = await chat.history(env.user.id, thread.id);
    expect(history.messages).toHaveLength(2);
    expect(history.messages[0]?.telegramSyncFailed).toBe(true);
    const stored = await env.repos.files.listForThreads([thread.id]);
    expect(stored).toHaveLength(2);
    for (const file of stored) {
      const download = await request(`/api/chat/threads/${thread.id}/files/${file.id}`, { headers: headers() });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(opaque.find(sample => sample.name === file.name)!.bytes);
    }
    const descriptors = await resolveThreadFileDescriptors({ repos: env.repos, thread: (await env.repos.threads.get(thread.id))! });
    expect(descriptors.map(file => file.fileId).sort()).toEqual(stored.map(file => file.id).sort());
    expect(descriptors.every(file => file.telegramRefs.length === 0)).toBe(true);
  });

  it("downloads active markup as attachments even with misleading names or MIME types", async () => {
    const thread = await chat.createThread(env.user.id, "Markup");
    const files = [
      { name: "page.html", mime: "text/html", bytes: Buffer.from("<script>alert(1)</script>") },
      { name: "drawing.svg", mime: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') },
      { name: "not-a-photo.png", mime: "image/png", bytes: Buffer.from("<html><script>alert(1)</script></html>") },
    ];
    expect((await upload(thread.id, files)).status).toBe(202);
    for (const file of await env.repos.files.listForThreads([thread.id])) {
      for (const mode of ["auto", "download"]) {
        const response = await request(`/api/chat/threads/${thread.id}/files/${file.id}?mode=${mode}`, { headers: headers() });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Disposition")).toContain("attachment");
        expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      }
    }
  });

  it("rejects too many files and oversized individual files before persistence", async () => {
    const thread = await chat.createThread(env.user.id, "Limits");
    expect((await upload(thread.id, Array.from({ length: 11 }, () => opaque[0]!))).status).toBe(413);
    expect((await upload(thread.id, [{ name: "oversized.bin", mime: "application/octet-stream", bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }])).status).toBe(413);
    expect(await env.repos.files.listForThreads([thread.id])).toEqual([]);
    expect(uploaded).toEqual([]);
  });

  it("accepts a 50 MiB file plus another attachment and serves the canonical bytes after Telegram accepts it", async () => {
    const thread = await chat.createThread(env.user.id, "Large uploads");
    const before = await env.repos.messages.insert({ threadId: thread.id, role: "user", content: {}, textPlain: "Before upload" });
    const fork = await env.repos.threads.create({ userId: env.user.id, title: "Before upload", topicId: null,
      parentThreadId: thread.id, forkPointMessageId: before.id });
    const bytes = Buffer.alloc(MAX_FILE_BYTES, 0xa5);
    const result = await upload(thread.id, [
      { name: "maximum.bin", mime: "application/octet-stream", bytes },
      { name: "extra.bin", mime: "application/octet-stream", bytes: Buffer.from([1, 2]) },
    ]);
    expect(result.status).toBe(202);
    const accepted = acceptedSchema.parse(await result.json());
    const file = (await env.repos.files.listForThreads([thread.id])).find(file => file.name === "maximum.bin")!;
    expect(file).toMatchObject({ size: MAX_FILE_BYTES, message_id: accepted.messageId, user_id: env.user.id, thread_id: thread.id });
    expect(uploaded.find(file => file.name === "maximum.bin")?.bytes.equals(bytes)).toBe(true);
    expect((await env.repos.files.listSources(file.id)).map(source => source.transport)).toEqual(expect.arrayContaining(["telegram", "web"]));
    const telegramFetch = vi.fn(async () => { throw new Error("Telegram getFile cannot download files above 20 MiB"); });
    env.services.fileResolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: telegramFetch });
    const download = await request(`/api/chat/threads/${thread.id}/files/${file.id}`, { headers: headers() });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
    expect(telegramFetch).not.toHaveBeenCalled();
    expect((await request(`/api/chat/threads/${fork.id}/files/${file.id}`, { headers: headers() })).status).toBe(404);
    const descriptors = await resolveThreadFileDescriptors({ repos: env.repos, thread: (await env.repos.threads.get(thread.id))! });
    expect(descriptors.find(item => item.fileId === file.id)).toMatchObject({ expectedSize: MAX_FILE_BYTES, expectedSha256: file.content_sha256 });
  }, 30_000);

});
