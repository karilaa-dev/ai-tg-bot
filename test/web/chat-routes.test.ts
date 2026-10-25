import { serve, type Server } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import type { FileResolver } from "../../src/files/resolver.js";
import { WebNotFound, type ConversationRepository } from "../../src/web/repository.js";
import type { ChatService, ChatThread } from "../../src/web/chat-types.js";
import { createWebRoutes, startWebServer, type WebServerOptions } from "../../src/web/server.js";
import { MAX_CHAT_BODY_BYTES } from "../../src/web/chat-routes.js";

const originalFetch = globalThis.fetch;
const publicOrigin = "https://chat.example";
let server: Server<undefined>;
let controller: AbortController;
let api: ReturnType<typeof createWebRoutes>;
let options: WebServerOptions;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
let nonce = "";
let identity = 42;
const profile = (id: number) => ({ id, name: `User ${id}`, username: null });
const thread = (id: number): ChatThread => ({ id, userId: id === 1 ? 42 : 84, origin: "web", topicId: null, title: `Thread ${id}`, archived: false, parentThreadId: null, forkPointMessageId: null, activity: null, lastActivity: 1, unread: false, lastMessageId: null });
let chat: ChatService;
const fileLookup = vi.fn();
const resolver = vi.fn();
const mutation = { "X-Chat-Request": "1", "X-Chat-User": "42", "Content-Type": "application/json", Origin: publicOrigin, "Sec-Fetch-Site": "same-origin" };
const request = (path: string, init?: RequestInit) => originalFetch(new URL(path, server.url), { redirect: "manual", ...init });
const cookies = (response: Response, kind: string) => response.headers.getSetCookie().find(value => value.startsWith(kind))!.split(";")[0]!;
async function login(userId = 42) {
  const start = await request("/api/auth/telegram/start");
  const location = new URL(start.headers.get("Location")!);
  nonce = location.searchParams.get("nonce")!;
  identity = userId;
  const response = await request(`/api/auth/telegram/callback?code=sample&state=${location.searchParams.get("state")}`, { headers: { Cookie: cookies(start, "__Host-ai_tg_bot_chat_login=") } });
  expect(response.status).toBe(303);
  return cookies(response, "__Host-ai_tg_bot_chat_session=");
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" };
});
beforeEach(() => {
  fileLookup.mockReset(); resolver.mockReset();
  const config = loadTestConfig({ WEB_ENABLED: true, WEB_TELEGRAM_CLIENT_ID: "123", WEB_TELEGRAM_CLIENT_SECRET: "dedicated-secret", WEB_PUBLIC_URL: publicOrigin, WEB_PORT: 0 });
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://oauth.telegram.org/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    if (url === "https://oauth.telegram.org/token") return Response.json({ id_token: await new SignJWT({ id: identity, nonce }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://oauth.telegram.org").setAudience("123").setSubject("opaque-subject").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey) });
    return originalFetch(input, init);
  });
  chat = {
    profile: vi.fn(async id => { if (![42, 84].includes(id)) throw new WebNotFound(); return profile(id); }),
    requireThread: vi.fn(async (userId, threadId) => { if (![1, 2].includes(threadId) || thread(threadId).userId !== userId) throw new WebNotFound(); }),
    markRead: vi.fn(async (_userId, _threadId, messageId) => ({ readMessageId: messageId, unread: false })),
    threads: vi.fn(async userId => ({ items: [thread(userId === 42 ? 1 : 2)], nextOffset: null })),
    history: vi.fn(async (userId, threadId) => ({ thread: thread(threadId), user: { ...profile(userId), lastActivity: 1, threadCount: 1 }, chain: [], messages: [], olderCursor: null, newerCursor: null, autoLoadMaxBytes: 0, maxFileBytes: 0 })),
    createThread: vi.fn(async () => thread(1)),
    send: vi.fn(async () => ({ turnId: 3, messageId: 4, queued: false })),
    stop: vi.fn(async () => {}), fork: vi.fn(async () => thread(1)), compact: vi.fn(async () => {}),
    settings: vi.fn<ChatService["settings"]>(async () => ({ language: "en", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true })),
    updateSettings: vi.fn(async (_id, patch) => ({ language: "en", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true, ...patch })),
    memories: vi.fn(), deleteMemory: vi.fn(), usage: vi.fn(),
    avatar: vi.fn<ChatService["avatar"]>(async () => null),
  };
  options = { config, chat: { service: chat, botUsername: "test_bot" }, repository: { file: fileLookup } as unknown as ConversationRepository, fileResolver: { resolveFile: resolver } as unknown as FileResolver, logger: createLogger(config) };
  controller = new AbortController();
  api = createWebRoutes(options, controller.signal);
  server = serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_CHAT_BODY_BYTES, routes: api.routes, fetch: api.fetch });
});
afterEach(async () => {
  controller.abort();
  await server.stop(true);
  await api.drain();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("refuses every private route before identity and keeps admin routes from ordinary accounts", async () => {
  expect(await (await request("/api/chat/session")).json()).toEqual({ authenticated: false, loginAvailable: true });
  for (const path of ["/api/chat/threads", "/api/chat/settings", "/api/chat/memories", "/api/chat/usage", "/api/chat/threads/1/messages", "/api/chat/threads/1/files/1"]) {
    expect((await request(path)).status).toBe(401);
  }
  expect(chat.profile).not.toHaveBeenCalled();
  const cookie = await login();
  const session = await request("/api/chat/session", { headers: { Cookie: cookie } });
  expect(await session.json()).toEqual({ authenticated: true, user: profile(42), botUsername: "test_bot", admin: false });
  expect(session.headers.get("Cache-Control")).toBe("no-store");
  for (const path of ["/api/users", "/api/usage", "/api/admin/codex", "/api/threads/1/files/1"]) expect((await request(path, { headers: { Cookie: cookie } })).status).toBe(403);
  expect((await request("/api/auth/login", { method: "POST", headers: { "X-Admin-Request": "1", "Content-Type": "application/json" }, body: '{"token":"anything"}' })).status).toBe(405);
});

it("serves the frontend at both / and /admin when started with OAuth alone", async () => {
  const assetsDirectory = await mkdtemp(path.join(tmpdir(), "chat-server-"));
  await writeFile(path.join(assetsDirectory, "index.html"), "<!doctype html><title>Chat frontend</title>");
  const web = await startWebServer({ ...options, config: { ...options.config, WEB_HOST: "127.0.0.1" }, assetsDirectory });
  try {
    expect(web).toBeDefined();
    for (const pathname of ["/", "/admin", "/admin/"]) {
      const result = await originalFetch(new URL(pathname, web!.url));
      expect(result.status).toBe(200);
      expect(result.headers.get("Content-Type")).toContain("text/html");
      expect(await result.text()).toContain("Chat frontend");
    }
  } finally { await web?.stop(); await rm(assetsDirectory, { recursive: true, force: true }); }
});

it("opens admin routes to the listed Telegram account with the same session cookie", async () => {
  options.config.WEB_ADMIN_USER_IDS = [84];
  const admin = await login(84);
  expect(await (await request("/api/chat/session", { headers: { Cookie: admin } })).json()).toMatchObject({ user: { id: 84 }, admin: true });
  const repository = options.repository as unknown as { users: (...args: unknown[]) => unknown };
  repository.users = vi.fn(async () => ({ items: [], nextOffset: null }));
  expect((await request("/api/users", { headers: { Cookie: admin } })).status).toBe(200);
  expect((await request("/api/chat/threads", { headers: { Cookie: admin, "X-Chat-User": "84" } })).status).toBe(200);
  expect((await request("/api/users", { headers: { Cookie: await login(42) } })).status).toBe(403);
  await request("/api/chat/session", { method: "DELETE", headers: { ...mutation, "X-Chat-User": "84", Cookie: admin } });
  expect((await request("/api/users", { headers: { Cookie: admin } })).status).toBe(401);
});

it("serves the signed-in account's Telegram photo and nothing when it has none", async () => {
  const cookie = await login();
  const headers = { Cookie: cookie, "X-Chat-User": "42" };
  expect((await request("/api/chat/avatar")).status).toBe(401);
  expect((await request("/api/chat/avatar", { headers: { Cookie: cookie, "X-Chat-User": "84" } })).status).toBe(401);
  const empty = await request("/api/chat/avatar", { headers });
  expect(empty.status).toBe(204);
  expect(await empty.text()).toBe("");
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  vi.mocked(chat.avatar).mockResolvedValue({ bytes: jpeg, mime: "image/jpeg" });
  const photo = await request("/api/chat/avatar", { headers });
  expect(photo.status).toBe(200);
  expect(photo.headers.get("Content-Type")).toBe("image/jpeg");
  expect(photo.headers.get("Cache-Control")).toBe("no-store");
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(jpeg);
  expect(chat.avatar).toHaveBeenLastCalledWith(42);
});

it("does not issue a session to an unknown or disallowed Telegram identity", async () => {
  for (const userId of [999, 42]) {
    const start = await request("/api/auth/telegram/start");
    const location = new URL(start.headers.get("Location")!);
    nonce = location.searchParams.get("nonce")!;
    identity = userId;
    if (userId === 42) options.config.BOT_ALLOWED_USER_IDS.push(84);
    const result = await request(`/api/auth/telegram/callback?state=${location.searchParams.get("state")}&code=sample`, { headers: { Cookie: cookies(start, "__Host-ai_tg_bot_chat_login=") } });
    expect(result.status).toBe(403);
    expect(result.headers.get("Set-Cookie")).toBeNull();
    expect(await result.json()).toEqual({ error: userId === 999 ? "Start a conversation with the bot in Telegram before signing in here." : "This Telegram account is not allowed to use this bot." });
  }
});

it("uses the session identity for lists, settings, memories and usage and rejects caller identity fields", async () => {
  const cookie = await login(84);
  const headers = { ...mutation, Cookie: cookie, "X-Chat-User": "84" };
  await request("/api/chat/threads?userId=42&offset=3", { headers });
  expect(chat.threads).toHaveBeenCalledWith(84, 3, "");
  await request("/api/chat/settings?user=42", { headers });
  expect(chat.settings).toHaveBeenCalledWith(84);
  await request("/api/chat/memories?user=42&offset=4", { headers });
  expect(chat.memories).toHaveBeenCalledWith(84, 4);
  await request("/api/chat/usage?user=42&days=7", { headers });
  expect(chat.usage).toHaveBeenCalledWith(84, 7, expect.any(AbortSignal));
  expect((await request("/api/chat/settings", { method: "PATCH", headers, body: '{"userId":42,"language":"ru"}' })).status).toBe(400);
  expect(chat.updateSettings).not.toHaveBeenCalled();
  expect((await request("/api/chat/settings", { method: "PATCH", headers, body: '{"language":"ru","streaming":false}' })).status).toBe(200);
  expect(chat.updateSettings).toHaveBeenCalledWith(84, { language: "ru", streaming: false });
});

it("bounds search and deletes zero-based memory IDs only for the verified account", async () => {
  const cookie = await login(84);
  const headers = { ...mutation, Cookie: cookie, "X-Chat-User": "84" };
  expect((await request("/api/chat/threads?q=%20hello%20&offset=50", { headers })).status).toBe(200);
  expect(chat.threads).toHaveBeenCalledWith(84, 50, "hello");
  expect((await request(`/api/chat/threads?q=${"x".repeat(201)}`, { headers })).status).toBe(400);
  const deleted = await request("/api/chat/memories/0?userId=42", { method: "DELETE", headers });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });
  expect(chat.deleteMemory).toHaveBeenCalledExactlyOnceWith(84, 0);
  expect((await request("/api/chat/memories/0", { method: "DELETE", headers: { ...headers, "X-Chat-User": "42" } })).status).toBe(401);
  expect((await request("/api/chat/memories/0", { method: "DELETE", headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
  expect((await request("/api/chat/memories/-1", { method: "DELETE", headers })).status).toBe(400);
  expect(chat.deleteMemory).toHaveBeenCalledTimes(1);
});

it("rejects another user's thread on every read, mutation and download before resolving files", async () => {
  const a = await login(42);
  const b = await login(84);
  const headers = { ...mutation, Cookie: a };
  for (const [path, method, body] of [
    ["messages", "GET", undefined], ["messages", "POST", '{"text":"attack","requestId":"a"}'],
    ["stop", "POST", undefined], ["fork", "POST", "{}"], ["compact", "POST", undefined],
    ["read", "POST", '{"messageId":1}'],
    ["files/10", "GET", undefined], ["files/10?mode=download&sandbox=start", "POST", undefined],
  ] as const) {
    expect((await request(`/api/chat/threads/2/${path}`, { method, headers, body })).status).toBe(404);
  }
  for (const fn of [chat.history, chat.send, chat.stop, chat.fork, chat.compact, chat.markRead, fileLookup, resolver]) expect(fn).not.toHaveBeenCalled();
  expect((await request("/api/chat/threads/1/messages", { headers })).status).toBe(200);
  expect((await request("/api/chat/threads/2/messages", { headers: { Cookie: b, "X-Chat-User": "84" } })).status).toBe(200);
  expect((await request("/api/chat/threads/1/messages", { headers: { Cookie: b, "X-Chat-User": "84" } })).status).toBe(404);
});

it("reuses safe file retrieval only for the owner and keeps sandbox consent checks", async () => {
  const cookie = await login();
  const headers = { ...mutation, Cookie: cookie };
  fileLookup.mockResolvedValue({ id: 10, size: 5, name: "note.txt", mime_type: "text/plain", type: "document" });
  resolver.mockResolvedValue({ bytes: Buffer.from("hello"), size: 5 });
  const download = await request("/api/chat/threads/1/files/10", { headers });
  expect(download.status).toBe(200);
  expect(await download.text()).toBe("hello");
  expect(download.headers.get("Content-Disposition")).toContain("attachment");
  expect(fileLookup).toHaveBeenCalledWith(1, 10);
  resolver.mockClear();
  expect((await request("/api/chat/threads/1/files/10?mode=download&sandbox=start", { headers })).status).toBe(400);
  expect((await request("/api/chat/threads/1/files/10?mode=download&sandbox=start", { method: "POST", headers })).status).toBe(403);
  expect(resolver).not.toHaveBeenCalled();
  const allowed = await request("/api/chat/threads/1/files/10?mode=download&sandbox=start", { method: "POST", headers: { ...headers, "X-Conversation-Sandbox-Consent": "start" } });
  expect(allowed.status).toBe(200);
  expect(resolver.mock.calls[0]?.[3]).toEqual({ allowSandboxResume: true, pauseAfterRead: true });
});

it("requires custom same-origin CSRF headers and rejects CORS preflight", async () => {
  const cookie = await login();
  const rejectedHeaders: Record<string, string>[] = [{ "X-Chat-Request": "" }, { Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.example", "X-Forwarded-Host": "evil.example" }];
  for (const extra of rejectedHeaders) {
    for (const [path, method] of [["/api/chat/threads", "POST"], ["/api/chat/settings", "PATCH"], ["/api/chat/session", "DELETE"]]) {
      expect((await request(path!, { method, headers: { ...mutation, Cookie: cookie, ...extra }, body: "{}" })).status).toBe(403);
    }
  }
  expect((await request("/api/chat/threads", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Headers": "X-Chat-Request" } })).status).toBe(405);
  expect(chat.createThread).not.toHaveBeenCalled();
  expect(chat.updateSettings).not.toHaveBeenCalled();
  expect((await request("/api/chat/session", { method: "DELETE", headers: { ...mutation, Cookie: cookie } })).status).toBe(200);
  expect((await request("/api/chat/threads", { headers: { Cookie: cookie } })).status).toBe(401);
});

it("parses bounded JSON and multipart uploads and rejects malformed input", async () => {
  const cookie = await login();
  const headers = { ...mutation, Cookie: cookie };
  const path = "/api/chat/threads/1/messages";
  expect((await request(path, { method: "POST", headers, body: '{"text":"hello","requestId":"request_retry_123"}' })).status).toBe(202);
  expect(chat.send).toHaveBeenLastCalledWith(42, 1, { text: "hello", requestId: "request_retry_123" });
  const form = new FormData(); form.set("text", "file message"); form.set("requestId", "request_upload_1"); form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));
  expect((await request(path, { method: "POST", headers: { "X-Chat-Request": "1", "X-Chat-User": "42", Origin: publicOrigin, Cookie: cookie }, body: form })).status).toBe(202);
  expect(chat.send).toHaveBeenLastCalledWith(42, 1, { text: "file message", requestId: "request_upload_1", files: [expect.objectContaining({ name: "note.txt", size: 5, type: expect.stringContaining("text/plain") })] });
  for (const body of ["{", "null", '{"text":"","requestId":"a"}', '{"text":"hello","requestId":"../bad"}', '{"text":"hello","requestId":"a","userId":84}', JSON.stringify({ text: "x".repeat(32_001), requestId: "a" })]) {
    expect((await request(path, { method: "POST", headers, body })).status).toBe(400);
  }
  expect((await request(path, { method: "POST", headers, body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
  expect((await request("/api/chat/threads/1/messages?before=1&after=2", { headers })).status).toBe(400);
  expect((await request("/api/chat/threads?offset=-1", { headers })).status).toBe(400);
  expect((await request("/api/chat/usage?days=31", { headers })).status).toBe(400);
});

it("rate-limits user mutations independently and ignores spoofed forwarded addresses", async () => {
  const cookie = await login();
  for (let i = 0; i < 30; i++) expect((await request("/api/chat/threads", { method: "POST", headers: { ...mutation, Cookie: cookie, "X-Forwarded-For": `192.0.2.${i}` }, body: "{}" })).status).toBe(201);
  const limited = await request("/api/chat/threads", { method: "POST", headers: { ...mutation, Cookie: cookie }, body: "{}" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBeTruthy();
  const second = await login(84);
  expect((await request("/api/chat/threads", { method: "POST", headers: { ...mutation, Cookie: second, "X-Chat-User": "84" }, body: "{}" })).status).toBe(201);
});

it("protects and bounds read acknowledgements before passing a verified message cursor", async () => {
  const cookie = await login();
  const headers = { ...mutation, Cookie: cookie };
  const path = "/api/chat/threads/1/read";
  expect((await request(path, { method: "POST", headers: mutation, body: '{"messageId":7}' })).status).toBe(401);
  expect((await request(path, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: '{"messageId":7}' })).status).toBe(403);
  expect((await request(path, { method: "POST", headers: { ...headers, "X-Chat-Request": "" }, body: '{"messageId":7}' })).status).toBe(403);
  expect((await request(path, { method: "POST", headers: { ...headers, "X-Chat-User": "84" }, body: '{"messageId":7}' })).status).toBe(401);
  for (const body of ["{}", "null", '{"messageId":0}', '{"messageId":-1}', '{"messageId":1.5}', '{"messageId":"7"}', '{"messageId":9007199254740992}', '{"messageId":7,"userId":84}']) {
    expect((await request(path, { method: "POST", headers, body })).status).toBe(400);
  }
  expect((await request(path, { method: "POST", headers, body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
  expect(chat.markRead).not.toHaveBeenCalled();
  const result = await request(path, { method: "POST", headers, body: '{"messageId":7}' });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ readMessageId: 7, unread: false });
  expect(chat.markRead).toHaveBeenCalledExactlyOnceWith(42, 1, 7);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
});

it("rate-limits read acknowledgements per verified account", async () => {
  const cookie = await login();
  const headers = { ...mutation, Cookie: cookie };
  for (let i = 0; i < 30; i++) expect((await request("/api/chat/threads/1/read", { method: "POST", headers, body: '{"messageId":7}' })).status).toBe(200);
  expect((await request("/api/chat/threads/1/read", { method: "POST", headers, body: '{"messageId":7}' })).status).toBe(429);
  expect(chat.markRead).toHaveBeenCalledTimes(30);
});

it("holds a user's submission slot through ingestion while admitting another user's message", async () => {
  const a = await login(42);
  const b = await login(84);
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  chat.send = vi.fn(async userId => {
    if (userId === 42) { entered(); await held; }
    return { turnId: 1, messageId: 1, queued: false };
  });
  const send = (cookie: string, threadId: number, requestId: string) => request(`/api/chat/threads/${threadId}/messages`, { method: "POST", headers: { ...mutation, Cookie: cookie, "X-Chat-User": cookie === a ? "42" : "84" }, body: JSON.stringify({ text: "hello", requestId }) });
  const first = send(a, 1, "request_first_123");
  try {
    await started;
    const rejected = await send(a, 1, "request_second_12");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("1");
    expect((await send(b, 2, "request_other_123")).status).toBe(202);
  } finally { release(); }
  expect((await first).status).toBe(202);
  expect((await send(a, 1, "request_after_123")).status).toBe(202);
});

it("shares the read budget with authenticated session profile queries", async () => {
  const cookie = await login();
  const headers = { Cookie: cookie, "X-Chat-User": "42" };
  for (let i = 0; i < 240; i++) expect((await request("/api/chat/session", { headers })).status).toBe(200);
  const before = vi.mocked(chat.profile).mock.calls.length;
  expect((await request("/api/chat/session", { headers })).status).toBe(429);
  expect((await request("/api/chat/threads", { headers })).status).toBe(429);
  expect(vi.mocked(chat.profile).mock.calls.length).toBe(before);
});

it("rejects stale-tab account assertions before reading, mutating, downloading or revoking another session", async () => {
  await login(42);
  const b = await login(84);
  vi.mocked(chat.profile).mockClear();
  for (const expected of ["42", "", "084"]) {
    const headers = { ...mutation, Cookie: b, "X-Chat-User": expected };
    for (const [url, method] of [
      ["/api/chat/threads", "GET"], ["/api/chat/threads", "POST"],
      ["/api/chat/settings", "PATCH"], ["/api/chat/threads/2/files/1", "GET"],
      ["/api/chat/session", "DELETE"],
    ]) {
      const result = await request(url!, { method, headers, ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}) });
      expect(result.status).toBe(401);
      expect(result.headers.get("Set-Cookie")).toBeNull();
    }
  }
  for (const fn of [chat.profile, chat.threads, chat.createThread, chat.updateSettings, fileLookup]) expect(fn).not.toHaveBeenCalled();
  expect(await (await request("/api/chat/session", { headers: { Cookie: b } })).json()).toMatchObject({ authenticated: true, user: { id: 84 } });
  expect((await request("/api/chat/threads", { headers: { Cookie: b, "X-Chat-User": "84" } })).status).toBe(200);
  expect(chat.threads).toHaveBeenCalledWith(84, 0, "");
});
