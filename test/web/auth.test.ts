import { serve, type Server } from "bun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import type { FileResolver } from "../../src/files/resolver.js";
import type { ConversationRepository } from "../../src/web/repository.js";
import { createWebRoutes, startWebServer, type WebServerOptions } from "../../src/web/server.js";
import { WebAdminAuth } from "../../src/web/auth.js";
import type { CodexStatus } from "../../src/web/admin-types.js";

const token = "test-admin-token";
const config = loadTestConfig({ WEB_ENABLED: true, WEB_ADMIN_TOKEN: token, WEB_PORT: 0 });
const mutationHeaders = { "Content-Type": "application/json", "X-Admin-Request": "1" };
let server: Server<undefined>;
let api: ReturnType<typeof createWebRoutes>;
let controller: AbortController;
let options: WebServerOptions;
let repository: Record<"users" | "threads" | "history" | "usageReport" | "file", ReturnType<typeof vi.fn>>;
let resolver: ReturnType<typeof vi.fn>;
type StatusMock = ReturnType<typeof vi.fn<() => Promise<CodexStatus>>>;
let codex: { status: StatusMock; start: StatusMock; cancel: StatusMock; stop: ReturnType<typeof vi.fn<() => Promise<void>>> };
const request = (pathname: string, init?: RequestInit) => fetch(new URL(pathname, server.url), init);
const login = (candidate = token, headers: Record<string, string> = {}) => request("/api/auth/login", {
  method: "POST", headers: { ...mutationHeaders, ...headers }, body: JSON.stringify({ token: candidate }),
});
const cookieOf = (response: Response) => response.headers.get("Set-Cookie")!.split(";")[0]!;

beforeEach(() => {
  repository = { users: vi.fn(async () => ({ items: [] })), threads: vi.fn(), history: vi.fn(), usageReport: vi.fn(), file: vi.fn() };
  resolver = vi.fn();
  const state: CodexStatus = { credentialStatus: "missing", login: { status: "idle" } };
  codex = { status: vi.fn(async () => state), start: vi.fn(async () => state), cancel: vi.fn(async () => state), stop: vi.fn(async () => {}) };
  options = { config, repository: repository as unknown as ConversationRepository,
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
});

it("fails closed when routes or a server are created without the environment token", async () => {
  for (const WEB_ADMIN_TOKEN of [undefined, "", " \n "]) {
    const invalid = { ...options, config: { ...config, WEB_ADMIN_TOKEN }, assetsDirectory: "/missing" };
    expect(() => createWebRoutes(invalid, controller.signal)).toThrow("WEB_ADMIN_TOKEN");
    for (const development of [false, true]) {
      await expect(startWebServer({ ...invalid, development })).rejects.toThrow("WEB_ADMIN_TOKEN");
    }
  }
});

it("blocks every conversation, attachment and account method before reading private data", async () => {
  for (const pathname of ["/api/users", "/api/users/1/threads", "/api/threads/1/messages", "/api/usage", "/api/threads/1/files/1", "/api/admin/codex"]) {
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
  expect(await (await request("/api/auth/session")).json()).toEqual({ authenticated: false });
  expect((await request(`/api/users?token=${token}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
});

it("issues opaque cookies, rotates sessions, rejects tampering and revokes logout server-side", async () => {
  expect((await login("wrong-token")).status).toBe(401);
  const signedIn = await login();
  expect(signedIn.status).toBe(200);
  expect(await signedIn.json()).toEqual({ authenticated: true });
  const header = signedIn.headers.get("Set-Cookie")!;
  expect(header).toContain("HttpOnly; SameSite=Strict; Max-Age=43200");
  expect(header).not.toContain(token);
  const cookie = cookieOf(signedIn);
  const headers = { Cookie: cookie };
  expect(await (await request("/api/auth/session", { headers })).json()).toEqual({ authenticated: true });
  expect((await request("/api/users", { headers })).status).toBe(200);
  expect((await request("/api/users", { headers: { Cookie: cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A") } })).status).toBe(401);
  const rotated = cookieOf(await login(token, headers));
  expect(rotated).not.toBe(cookie);
  expect((await request("/api/users", { headers })).status).toBe(401);
  expect((await request("/api/users", { headers: { Cookie: rotated } })).status).toBe(200);
  const logout = await request("/api/auth/session", { method: "DELETE", headers: { ...mutationHeaders, Cookie: rotated } });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await request("/api/users", { headers: { Cookie: rotated } })).status).toBe(401);
});

it("expires sessions after twelve hours even when a client keeps sending the cookie", async () => {
  const cookie = cookieOf(await login());
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 12 * 60 * 60_000);
  expect(await (await request("/api/auth/session", { headers: { Cookie: cookie } })).json()).toEqual({ authenticated: false });
  expect((await request("/api/users", { headers: { Cookie: cookie } })).status).toBe(401);
});

it("limits guessing even when callers spoof client IP headers", async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    expect((await login("incorrect", { "X-Forwarded-For": `192.0.2.${attempt}` })).status).toBe(401);
  }
  const blocked = await login("wrong-token", { "X-Forwarded-For": "203.0.113.99" });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect((await login()).status).toBe(429);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
  expect((await login()).status).toBe(200);
  expect((await login("wrong-token")).status).toBe(401);
});

it("isolates sign-in limits by socket peer while preserving existing sessions", async () => {
  const auth = new WebAdminAuth(token);
  const attempt = (candidate: string, peer: string) => auth.login(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ token: candidate }),
  }), peer);
  const cookie = (await attempt(token, "192.0.2.1")).split(";")[0]!;
  for (let i = 0; i < 10; i++) await expect(attempt("wrong", "192.0.2.1")).rejects.toMatchObject({ status: 401 });
  await expect(attempt("wrong", "192.0.2.1")).rejects.toMatchObject({ status: 429 });
  await expect(attempt("wrong", "192.0.2.2")).rejects.toMatchObject({ status: 401 });
  await expect(attempt(token, "192.0.2.1")).rejects.toMatchObject({ status: 429 });
  expect(auth.authenticated(new Request("http://localhost/api/users", { headers: { Cookie: cookie } }))).toBe(true);
  await expect(attempt(token, "192.0.2.2")).resolves.toContain("HttpOnly");
  await expect(attempt("wrong", "192.0.2.1")).rejects.toMatchObject({ status: 429 });
});

it("bounds login JSON before comparing credentials", async () => {
  for (const [body, status] of [["broken", 400], ["null", 400], ['{"token":5}', 400], [JSON.stringify({ token: "x".repeat(4_096) }), 413]] as const) {
    const response = await request("/api/auth/login", { method: "POST", headers: mutationHeaders, body });
    expect(response.status).toBe(status);
    expect(response.headers.has("Set-Cookie")).toBe(false);
  }
  expect((await request("/api/auth/login", { method: "POST", headers: { "X-Admin-Request": "1" }, body: token })).status).toBe(415);
  const streamed = new Request("http://localhost/api/auth/login", {
    method: "POST", headers: mutationHeaders,
    body: new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(4_097)); stream.close(); } }),
  });
  await expect(new WebAdminAuth(token).login(streamed)).rejects.toMatchObject({ status: 413 });
});

describe("same-origin mutations", () => {
  it("rejects cross-site or same-site requests and requires the custom header", async () => {
    const cookie = cookieOf(await login());
    const paths = [["/api/auth/login", "POST"], ["/api/auth/session", "DELETE"], ["/api/admin/codex/login", "POST"], ["/api/admin/codex/login", "DELETE"]] as const;
    for (const [pathname, method] of paths) {
      for (const extra of [{ "X-Admin-Request": "" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://attacker.test" }, { Origin: "null" }, { Origin: "https://attacker.test", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https" }] as Record<string, string>[]) {
        const response = await request(pathname, { method, headers: { ...mutationHeaders, Cookie: cookie, ...extra }, ...(method === "POST" ? { body: JSON.stringify({ token }) } : {}) });
        expect(response.status).toBe(403);
      }
    }
    expect(codex.start).not.toHaveBeenCalled();
    expect(codex.cancel).not.toHaveBeenCalled();
    expect((await request("/api/users", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("accepts same-origin browser requests and marks HTTPS proxy cookies Secure", async () => {
    expect((await login(token, { Origin: server.url.origin, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    const https = new URL(server.url);
    https.protocol = "https:";
    const forwarded = await login(token, { Origin: https.origin, "X-Forwarded-Proto": "https", "Sec-Fetch-Site": "same-origin" });
    expect(forwarded.status).toBe(200);
    expect(forwarded.headers.get("Set-Cookie")).toContain("; Secure");
    const auth = new WebAdminAuth(token);
    const cookie = await auth.login(new Request("https://admin.example/api/auth/login", {
      method: "POST", headers: { ...mutationHeaders, "X-Forwarded-Proto": "http" }, body: JSON.stringify({ token }),
    }));
    expect(cookie).toContain("; Secure");
  });

  it("never permits CORS preflight or unsupported methods", async () => {
    for (const pathname of ["/api/auth/login", "/api/auth/session", "/api/admin/codex", "/api/admin/codex/login", "/api/users"]) {
      for (const method of ["OPTIONS", "PUT", "PATCH"]) {
        const response = await request(pathname, { method, headers: { Origin: "https://attacker.test", "Access-Control-Request-Headers": "X-Admin-Request" } });
        expect(response.status).toBe(405);
        expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
      }
    }
  });
});

it("exposes account controls only to authenticated admins and handles an absent service", async () => {
  const headers = { ...mutationHeaders, Cookie: cookieOf(await login()) };
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
