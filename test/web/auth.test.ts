import { AccessControl } from "../../src/access/control.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { serve, type Server } from "bun";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import type { FileResolver } from "../../src/files/resolver.js";
import type { ConversationRepository } from "../../src/web/repository.js";
import { createWebRoutes, startWebServer, type WebServerOptions } from "../../src/web/server.js";
import type { CodexStatus } from "../../src/web/admin-types.js";
import { fakeTelegramLogin, signInOnlyChat, telegramLoginConfig } from "../helpers/telegram-login.js";

const adminId = 7;
const memberId = 42;
const config = loadTestConfig({ WEB_ENABLED: true, ...telegramLoginConfig, WEB_ADMIN_USER_IDS: [adminId], WEB_PORT: 0 });
const mutationHeaders = { "Content-Type": "application/json", "X-Admin-Request": "1" };
let login: Awaited<ReturnType<typeof fakeTelegramLogin>>;
let server: Server<undefined>;
let api: ReturnType<typeof createWebRoutes>;
let controller: AbortController;
let options: WebServerOptions;
let access: AccessControl;
let db: AppDatabase;
let repository: Record<"users" | "threads" | "history" | "usageReport" | "file", ReturnType<typeof vi.fn>>;
let resolver: ReturnType<typeof vi.fn>;
type StatusMock = ReturnType<typeof vi.fn<() => Promise<CodexStatus>>>;
let codex: { status: StatusMock; start: StatusMock; cancel: StatusMock; stop: ReturnType<typeof vi.fn<() => Promise<void>>> };
const request = (pathname: string, init?: RequestInit) => fetch(new URL(pathname, server.url), init);
const signIn = (userId = adminId) => login.signIn(server.url, userId);
const adminPaths = ["/api/users", "/api/users/1/threads", "/api/users/1/memories", "/api/threads/1/messages", "/api/usage", "/api/threads/1/files/1", "/api/admin/codex", "/api/admin/allowed-users"];

beforeAll(async () => { login = await fakeTelegramLogin(); });
beforeEach(async () => {
  repository = { users: vi.fn(async () => ({ items: [] })), threads: vi.fn(), history: vi.fn(), usageReport: vi.fn(), file: vi.fn() };
  resolver = vi.fn();
  const state: CodexStatus = { credentialStatus: "missing", login: { status: "idle" } };
  codex = { status: vi.fn(async () => state), start: vi.fn(async () => state), cancel: vi.fn(async () => state), stop: vi.fn(async () => {}) };
  db = createDatabase(config);
  await db.initialize();
  access = new AccessControl(db.db);
  await access.initialize();
  for (const id of [7, 42]) await access.allow(id);
  options = { config, access, repository: repository as unknown as ConversationRepository, chat: signInOnlyChat(), telegramAuth: login.dependencies,
    fileResolver: { resolveFile: resolver } as unknown as FileResolver, logger: createLogger(config), codexLogin: codex };
  controller = new AbortController();
  api = createWebRoutes(options, controller.signal);
  server = serve({ hostname: "127.0.0.1", port: 0, development: false, routes: api.routes, fetch: api.fetch });
});

afterEach(async () => {
  vi.restoreAllMocks();
  controller.abort();
  await server.stop(true);
  await api.drain();
  await db.destroy();
});

it("fails closed when routes or a server are created without Telegram login", async () => {
  for (const field of ["WEB_TELEGRAM_CLIENT_ID", "WEB_TELEGRAM_CLIENT_SECRET", "WEB_PUBLIC_URL"] as const) {
    const invalid = { ...options, config: { ...config, [field]: undefined }, assetsDirectory: "/missing" };
    expect(() => createWebRoutes(invalid, controller.signal)).toThrow("Telegram login");
    for (const development of [false, true]) {
      await expect(startWebServer({ ...invalid, development })).rejects.toThrow("Telegram login");
    }
  }
});

it("blocks every conversation, attachment and account method before reading private data", async () => {
  for (const pathname of adminPaths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(pathname, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
  }
  for (const pathname of ["/api/threads/1/files/1?mode=download&sandbox=start", "/api/admin/codex/login"]) {
    expect((await request(pathname, { method: "POST", headers: mutationHeaders })).status).toBe(401);
  }
  expect((await request("/api/admin/codex/login", { method: "DELETE", headers: mutationHeaders })).status).toBe(401);
  for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  for (const method of Object.values(codex)) expect(method).not.toHaveBeenCalled();
  expect(resolver).not.toHaveBeenCalled();
});

it("admits only listed Telegram accounts and tells the client who is an admin", async () => {
  const member = await signIn(memberId);
  for (const pathname of adminPaths) {
    const response = await request(pathname, { headers: { Cookie: member } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This Telegram account does not have admin access." });
  }
  expect((await request("/api/admin/codex/login", { method: "POST", headers: { ...mutationHeaders, Cookie: member } })).status).toBe(403);
  for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  expect(codex.start).not.toHaveBeenCalled();
  expect(await (await request("/api/chat/session", { headers: { Cookie: member } })).json()).toMatchObject({ authenticated: true, user: { id: memberId }, admin: false });

  const admin = await signIn();
  expect(await (await request("/api/chat/session", { headers: { Cookie: admin } })).json()).toMatchObject({ authenticated: true, user: { id: adminId }, admin: true });
  expect((await request("/api/users", { headers: { Cookie: admin } })).status).toBe(200);
  expect((await request("/api/users", { headers: { Cookie: admin.slice(0, -1) + (admin.endsWith("A") ? "B" : "A") } })).status).toBe(401);
  // The retired token sign-in is gone; only the Telegram session is accepted.
  expect((await request("/api/auth/login", { method: "POST", headers: mutationHeaders, body: '{"token":"anything"}' })).status).toBe(405);
  expect((await request("/api/auth/session", { headers: { Cookie: admin } })).status).toBe(404);
});

it("ends admin access when the Telegram session signs out or expires", async () => {
  const cookie = await signIn();
  const signOut = await request("/api/chat/session", { method: "DELETE", headers: { "X-Chat-Request": "1", "X-Chat-User": String(adminId), Cookie: cookie } });
  expect(signOut.status).toBe(200);
  expect(signOut.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await request("/api/users", { headers: { Cookie: cookie } })).status).toBe(401);
  const next = await signIn();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 12 * 60 * 60_000);
  expect((await request("/api/users", { headers: { Cookie: next } })).status).toBe(401);
});

it("sends a finished admin sign-in back to the admin page", async () => {
  const start = await request("/api/auth/telegram/start?return=/admin", { redirect: "manual" });
  const location = new URL(start.headers.get("Location")!);
  expect(location.searchParams.get("redirect_uri")).toBe("https://chat.example/api/auth/telegram/callback");
  const page = login.serveAuthorizePage(adminId, () => server.url);
  try {
    const approved = await fetch(`${page.authorizeUrl}${location.search}`, { redirect: "manual" });
    const done = await fetch(approved.headers.get("Location")!, { redirect: "manual", headers: { Cookie: start.headers.getSetCookie()[0]!.split(";")[0]! } });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe("/admin");
  } finally { await page.stop(); }
});

describe("same-origin mutations", () => {
  it("rejects cross-site or same-site requests and requires the custom header", async () => {
    const cookie = await signIn();
    const paths = [["/api/admin/codex/login", "POST"], ["/api/admin/codex/login", "DELETE"], ["/api/admin/allowed-users", "POST"], ["/api/admin/allowed-users/42", "DELETE"], ["/api/threads/1/files/1?mode=download&sandbox=start", "POST"]] as const;
    for (const [pathname, method] of paths) {
      for (const extra of [{ "X-Admin-Request": "" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://attacker.test" }, { Origin: "null" }, { Origin: "https://attacker.test", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https" }] as Record<string, string>[]) {
        const response = await request(pathname, { method, headers: { ...mutationHeaders, Cookie: cookie, ...extra } });
        expect(response.status).toBe(403);
      }
    }
    expect(codex.start).not.toHaveBeenCalled();
    expect(codex.cancel).not.toHaveBeenCalled();
    expect((await request("/api/users", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("accepts same-origin browser requests, including behind an HTTPS proxy", async () => {
    const cookie = await signIn();
    expect((await request("/api/admin/codex/login", { method: "POST", headers: { ...mutationHeaders, Cookie: cookie, Origin: server.url.origin, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
    const https = new URL(server.url);
    https.protocol = "https:";
    expect((await request("/api/admin/codex/login", { method: "POST", headers: { ...mutationHeaders, Cookie: cookie, Origin: https.origin, "X-Forwarded-Proto": "https", "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  });

  it("never permits CORS preflight or unsupported methods", async () => {
    for (const pathname of ["/api/admin/codex", "/api/admin/codex/login", "/api/users"]) {
      for (const method of ["OPTIONS", "PUT", "PATCH"]) {
        const response = await request(pathname, { method, headers: { Origin: "https://attacker.test", "Access-Control-Request-Headers": "X-Admin-Request" } });
        expect(response.status).toBe(405);
        expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
      }
    }
  });
});

it("exposes account controls only to authenticated admins and handles an absent service", async () => {
  const headers = { ...mutationHeaders, Cookie: await signIn() };
  expect((await request("/api/admin/codex", { headers })).status).toBe(200);
  expect((await request("/api/admin/codex/login", { method: "POST", headers })).status).toBe(200);
  expect((await request("/api/admin/codex/login", { method: "DELETE", headers })).status).toBe(200);
  expect(codex.status).toHaveBeenCalledOnce();
  expect(codex.start).toHaveBeenCalledOnce();
  expect(codex.cancel).toHaveBeenCalledOnce();
  options.codexLogin = undefined;
  const unavailable = await request("/api/admin/codex", { headers });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "Codex sign-in is unavailable. Restart the application and try again." });
});

it("bootstraps configured administrators without bot registration or chat access", async () => {
  await access.revoke(adminId);
  options.chat = undefined;
  const cookie = await signIn();
  expect(await (await request("/api/admin/session", { headers: { Cookie: cookie } })).json())
    .toEqual({ authenticated: true, userId: adminId, admin: true });
  expect(await (await request("/api/chat/session", { headers: { Cookie: cookie } })).json())
    .toMatchObject({ authenticated: false });
  expect((await request("/api/admin/allowed-users", { headers: { Cookie: cookie } })).status).toBe(200);
  expect(await access.isAllowed(adminId)).toBe(false);
});

it("lets only admins add and remove pending registrations without creating a user", async () => {
  const headers = { ...mutationHeaders, Cookie: await signIn() };
  const member = await signIn(memberId);
  expect((await request("/api/admin/allowed-users", { method: "POST", headers: { ...headers, Cookie: member }, body: '{"telegramId":999}' })).status).toBe(403);
  expect((await request("/api/admin/allowed-users/42", { method: "DELETE", headers: { ...headers, Cookie: member } })).status).toBe(403);
  for (const telegramId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "999"]) {
    expect((await request("/api/admin/allowed-users", { method: "POST", headers, body: JSON.stringify({ telegramId }) })).status).toBe(400);
  }
  const added = await request("/api/admin/allowed-users", { method: "POST", headers, body: '{"telegramId":999}' });
  expect(added.status).toBe(200);
  expect((await added.json()).users).toContainEqual({ telegramId: 999, firstName: null, username: null, registered: false, createdAt: expect.any(Number) });
  expect(await access.isAllowed(999)).toBe(true);
  expect((await request("/api/admin/allowed-users/999", { method: "DELETE", headers })).status).toBe(200);
  expect(await access.isAllowed(999)).toBe(false);
});

it("revokes existing member sessions for reads, mutations and attachments, even after re-allowing", async () => {
  const member = await signIn(memberId);
  const admin = await signIn();
  expect((await request(`/api/admin/allowed-users/${memberId}`, { method: "DELETE", headers: { ...mutationHeaders, Cookie: admin } })).status).toBe(200);
  expect(await (await request("/api/chat/session", { headers: { Cookie: member } })).json()).toMatchObject({ authenticated: false });
  for (const path of ["/api/chat/threads", "/api/chat/settings", "/api/chat/threads/1/files/1"]) {
    expect((await request(path, { headers: { Cookie: member, "X-Chat-User": String(memberId) } })).status).toBe(401);
  }
  expect((await request("/api/chat/threads", { method: "POST", headers: { "X-Chat-Request": "1", "X-Chat-User": String(memberId), Cookie: member, "Content-Type": "application/json" }, body: '{}' })).status).toBe(401);
  expect(resolver).not.toHaveBeenCalled();
  expect(repository.file).not.toHaveBeenCalled();
  await access.allow(memberId);
  expect((await request("/api/chat/settings", { headers: { Cookie: member, "X-Chat-User": String(memberId) } })).status).toBe(401);
});
