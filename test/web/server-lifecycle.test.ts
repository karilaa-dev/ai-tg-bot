import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { FileResolver } from "../../src/files/resolver.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { startWebServer } from "../../src/web/server.js";
import { deferred } from "../helpers/async.js";
import { SandboxConsentRequired } from "../../src/files/source.js";

let database: AppDatabase;
let assetsDirectory: string;
let web: Awaited<ReturnType<typeof startWebServer>>;
let resolver: FileResolver;
let fileUrl: URL;
let cookie: string;
let repository: ConversationRepository;
const request = (url: URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", cookie);
  headers.set("X-Admin-Request", "1");
  return fetch(url, { ...init, headers });
};

beforeEach(async () => {
  const config = loadTestConfig({ WEB_ENABLED: true, WEB_ADMIN_TOKEN: "test-admin-token", WEB_HOST: "127.0.0.1", WEB_PORT: 0 });
  database = createDatabase(config);
  await database.initialize();
  const repos = createRepos(database.db, database.search);
  await repos.users.ensure({ tgId: 1, firstName: "Alice" });
  const thread = await repos.threads.create({ userId: 1, topicId: null, title: "Test" });
  const message = await repos.messages.insert({ threadId: thread.id, role: "user", textPlain: "Hello", content: {} });
  const file = await repos.files.insertFile({ userId: 1, threadId: thread.id, messageId: message.id, type: "txt", name: "test.txt", size: 5, mimeType: "text/plain", isInline: true });
  await repos.files.rememberSource(file.id, { transport: "fixture", connectionKey: "default", remoteKey: "file", locator: {} });
  resolver = new FileResolver(repos.files);
  assetsDirectory = await mkdtemp(path.join(tmpdir(), "bun-web-test-"));
  await Promise.all([
    writeFile(path.join(assetsDirectory, "index.html"), "<!doctype html><title>Archive</title>"),
    writeFile(path.join(assetsDirectory, "app.js"), "window.loaded = true;"),
    writeFile(path.join(assetsDirectory, "style.css"), "body { color: blue; }"),
    writeFile(path.join(assetsDirectory, "index-123abc45.js"), "window.hashed = true;"),
    writeFile(path.join(assetsDirectory, "index-123abc45.css"), "body { color: red; }"),
    writeFile(path.join(assetsDirectory, "index-123abc45.html"), "<!doctype html><title>Uncached</title>"),
    writeFile(path.join(assetsDirectory, "index-123abc45.js.map"), "source code"),
    writeFile(path.join(assetsDirectory, "private.txt"), "not an asset"),
  ]);
  await symlink(path.join(assetsDirectory, "private.txt"), path.join(assetsDirectory, "symlink.js"));
  repository = new ConversationRepository(database.db, repos);
  web = await startWebServer({ config, repository, fileResolver: resolver, logger: createLogger(config), assetsDirectory });
  const login = await fetch(new URL("/api/auth/login", web!.url), {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Request": "1" },
    body: JSON.stringify({ token: config.WEB_ADMIN_TOKEN }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
  fileUrl = new URL(`/api/threads/${thread.id}/files/${file.id}?mode=auto`, web!.url);
});

afterEach(async () => {
  await web?.stop();
  await database.destroy();
  await rm(assetsDirectory, { recursive: true, force: true });
});

it("serves packaged assets with browser-compatible types and handles HEAD without downloading", async () => {
  expect((await fetch(web!.url)).status).toBe(200);
  expect((await fetch(new URL("/app.js", web!.url))).status).toBe(200);
  for (const [asset, mime] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/style.css", "text/css"]]) {
    const url = new URL(asset!, web!.url);
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(mime);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBe(Number(response.headers.get("content-length")));
    const head = await request(url, { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
  }
  expect((await request(new URL("/private.txt", web!.url))).status).toBe(404);
  expect((await request(new URL("/symlink.js", web!.url))).status).toBe(404);
  expect((await request(fileUrl, { method: "HEAD" })).status).toBe(200);
  expect((await request(new URL("/api/users", web!.url), { method: "POST", body: "ignored" })).status).toBe(405);
  await writeFile(path.join(assetsDirectory, "app.js"), "window.rebuilt = true;");
  expect(await (await request(new URL("/app.js", web!.url))).text()).toBe("window.rebuilt = true;");
});

it("stops the Codex login worker exactly once when the website stops", async () => {
  const state = { credentialStatus: "missing" as const, login: { status: "idle" as const } };
  const stop = vi.fn(async () => {});
  const config = loadTestConfig({ WEB_ENABLED: true, WEB_ADMIN_TOKEN: "test-admin-token", WEB_HOST: "127.0.0.1", WEB_PORT: 0 });
  const other = await startWebServer({ config, repository, fileResolver: resolver, logger: createLogger(config), assetsDirectory,
    codexLogin: { status: async () => state, start: async () => state, cancel: async () => state, stop } });
  await Promise.all([other!.stop(), other!.stop()]);
  expect(stop).toHaveBeenCalledOnce();
});

it("caches only hashed bundles and keeps HTML, API responses, downloads, and errors private", async () => {
  resolver.registry.register({ transport: "fixture", connectionKey: "default", fetch: async () => Buffer.from("hello") });
  for (const asset of ["/index-123abc45.js", "/index-123abc45.css"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(new URL(asset, web!.url), { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  }
  for (const url of [new URL("/", web!.url), new URL("/index-123abc45.html", web!.url), new URL("/api/users", web!.url), fileUrl, new URL("/missing", web!.url)]) {
    expect((await request(url)).headers.get("cache-control")).toBe("no-store");
  }
  expect((await request(new URL("/index-123abc45.js.map", web!.url))).status).toBe(404);
  expect((await request(new URL("/src/web/client/app.tsx", web!.url))).status).toBe(404);
  expect((await request(new URL("/index-123abc45.js", web!.url), { method: "POST" })).status).toBe(405);
});

function waitForCancellation() {
  const started = deferred<AbortSignal>();
  const aborted = deferred<void>();
  const cleanup = deferred<void>();
  resolver.registry.register({ transport: "fixture", connectionKey: "default", fetch: (_source, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => {
      aborted.resolve();
      void cleanup.promise.then(() => reject(signal!.reason));
    }, { once: true });
    started.resolve(signal!);
  }) });
  return { started, aborted, cleanup };
}

it("accepts explicit sandbox POSTs through the HTTP adapter and rejects cross-site requests", async () => {
  let approved = 0;
  resolver.registry.register({ transport: "fixture", connectionKey: "default", fetch: async (_source, _signal, _max, policy) => {
    if (!policy?.allowSandboxResume) throw new SandboxConsentRequired();
    approved++;
    return Buffer.from("hello");
  } });
  const consentUrl = new URL(fileUrl);
  consentUrl.search = "?mode=download&sandbox=start";
  expect((await request(fileUrl)).status).toBe(409);
  expect((await request(consentUrl)).status).toBe(400);
  const preflight = await request(consentUrl, { method: "OPTIONS", headers: { Origin: "https://attacker.test" } });
  expect(preflight.status).toBe(405);
  expect(preflight.headers.has("Access-Control-Allow-Origin")).toBe(false);
  for (const headers of [{ Origin: "https://attacker.test" }, { "X-Conversation-Sandbox-Consent": "start", "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
    expect((await request(consentUrl, { method: "POST", headers })).status).toBe(403);
  }
  expect(approved).toBe(0);
  // Fetch Metadata is unavailable on some HTTP origins; the non-simple header still prevents CSRF.
  for (const headers of [{ "X-Conversation-Sandbox-Consent": "start" }, { "X-Conversation-Sandbox-Consent": "start", "Sec-Fetch-Site": "same-origin" }] as Record<string, string>[]) {
    expect(await (await request(consentUrl, { method: "POST", headers })).text()).toBe("hello");
  }
  expect(approved).toBe(2);
});

it("cancels attachment retrieval when the browser disconnects", async () => {
  const pending = waitForCancellation();
  const browser = new AbortController();
  const download = request(fileUrl, { signal: browser.signal }).catch(error => error);
  try {
    const signal = await pending.started.promise;
    browser.abort();
    await pending.aborted.promise;
    expect(signal.aborted).toBe(true);
    expect(await download).toBeInstanceOf(Error);
  } finally { pending.cleanup.resolve(); }
});

it("waits for cancelled download cleanup before shutdown completes and allows repeated stop calls", async () => {
  const pending = waitForCancellation();
  const download = request(fileUrl).catch(error => error);
  try {
    await pending.started.promise;
    let stopped = false;
    const stopping = web!.stop().then(() => { stopped = true; });
    await pending.aborted.promise;
    await setImmediate();
    expect(stopped).toBe(false);
    pending.cleanup.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(await download).toBeInstanceOf(Error);
    await web!.stop();
  } finally { pending.cleanup.resolve(); }
});
