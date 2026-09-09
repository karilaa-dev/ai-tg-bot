import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { FileResolver } from "../../src/files/resolver.js";
import { createLogger } from "../../src/logger.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createWebHandler, startWebServer } from "../../src/web/server.js";
import { userLabel } from "../../src/web/types.js";

describe.each(["sqlite", ...(process.env.TEST_POSTGRES_URL ? ["postgres"] : [])])("conversation browser (%s)", dialect => {
  let database: AppDatabase;
  let admin: AppDatabase | undefined;
  let schema: string;
  let repos: Repos;
  let repository: ConversationRepository;
  let resolver: FileResolver;
  let request: (path: string, init?: RequestInit) => Promise<Response>;
  let controller: AbortController;
  const config = loadTestConfig({ WEB_ENABLED: true });

  beforeEach(async () => {
    let dbUrl = "sqlite::memory:";
    if (dialect === "postgres") {
      schema = `web_test_${randomUUID().replaceAll("-", "")}`;
      admin = createDatabase({ DB_URL: process.env.TEST_POSTGRES_URL! });
      await admin.db.execute(sql.raw(`create schema ${schema}`));
      const url = new URL(process.env.TEST_POSTGRES_URL!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      dbUrl = url.toString();
    }
    database = createDatabase({ DB_URL: dbUrl });
    await database.initialize();
    repos = createRepos(database.db, database.search);
    repository = new ConversationRepository(database.db, repos);
    resolver = new FileResolver(repos.files);
    controller = new AbortController();
    const handler = createWebHandler({ config, repository, fileResolver: resolver, logger: createLogger(config) }, controller.signal);
    request = (url, init) => handler(new Request(`http://localhost${url}`, init));
  });
  afterEach(async () => {
    controller.abort();
    await database.destroy();
    if (admin) { await admin.db.execute(sql.raw(`drop schema ${schema} cascade`)); await admin.destroy(); admin = undefined; }
  });

  async function thread(userId = 1, title = "General") {
    await repos.users.ensure({ tgId: userId, firstName: `Person ${userId}`, username: userId === 1 ? "alice" : undefined });
    return repos.threads.create({ userId, title, topicId: null });
  }
  async function message(threadId: number, text = "Hello") {
    return repos.messages.insert({ threadId, role: "user", content: { text, hidden: "not in API" }, textPlain: text });
  }
  async function attachment(threadId: number, messageId: number, size: number, mimeType = "text/plain") {
    const file = await repos.files.insertFile({ userId: 1, threadId, messageId, name: "notes.txt", size, mimeType, type: "txt", isInline: true });
    await repos.files.rememberSource(file.id, { transport: "test", connectionKey: "default", remoteKey: String(file.id), locator: { secret: "hidden" } });
    return file;
  }

  it("uses saved identity, literal search, stable recent activity ordering, and pages", async () => {
    const first = await thread();
    const second = await thread(2);
    const old = await message(first.id);
    const recent = await message(second.id);
    await database.db.execute(sql`update messages set created_at = 10 where id = ${old.id}`);
    await database.db.execute(sql`update messages set created_at = 20 where id = ${recent.id}`);
    expect((await repository.users("", 0, 1)).items.map(u => u.id)).toEqual([2]);
    expect((await repository.users("", 0, 1)).nextOffset).toBe(1);
    expect((await repository.users("", 1, 1)).items[0]?.username).toBe("alice");
    expect((await repository.users("ALICE", 0)).items.map(u => u.id)).toEqual([1]);
    expect((await repository.users("%", 0)).items).toEqual([]);
    expect((await repository.users("Person 2", 0)).items.map(u => u.id)).toEqual([2]);
    expect((await repository.users("2", 0)).items.map(u => u.id)).toEqual([2]);
    expect(userLabel({ id: 1, name: "Alice", username: "alice" })).toBe("@alice");
    expect(userLabel({ id: 1, name: "Alice", username: null })).toBe("Alice");
    expect(userLabel({ id: 1, name: null, username: null })).toBe("User 1");
  });

  it("includes archived threads, paginates history, and refreshes the latest message", async () => {
    const t = await thread();
    await repos.threads.archive(t.id);
    const ids: number[] = [];
    for (let i = 0; i < 55; i++) ids.push((await message(t.id, `Message ${i}`)).id);
    expect((await repository.threads(1, 0)).items[0]?.archived).toBe(true);
    const latest = await repository.history(t.id);
    expect(latest.messages.map(m => m.id)).toEqual(ids.slice(5));
    expect((await repository.history(t.id, latest.olderCursor!)).messages.map(m => m.id)).toEqual(ids.slice(0, 5));
    await repos.messages.setThinking(ids.at(-1)!, "Saved thinking");
    expect((await repository.history(t.id, undefined, ids.at(-1))).messages[0]?.thinking).toBe("Saved thinking");
    const serialized = JSON.stringify(latest);
    expect(serialized).not.toContain("content_json");
    expect(serialized).not.toContain("pi_session");
  });

  it("honors nested fork cutoffs and preserves shared attachment names/captions", async () => {
    const parent = await thread();
    const first = await message(parent.id, "Inherited");
    const second = await message(parent.id, "Later parent message");
    const child = await repos.threads.create({ userId: 1, topicId: 2, title: "Child", parentThreadId: parent.id, forkPointMessageId: second.id });
    const own = await message(child.id, "Child message");
    const grandchild = await repos.threads.create({ userId: 1, topicId: 3, title: "Grandchild", parentThreadId: child.id, forkPointMessageId: first.id });
    const grandOwn = await message(grandchild.id, "Grandchild message");
    const file = await attachment(parent.id, first.id, 5);
    await repos.files.attachToMessage(own.id, file.id, { displayName: "shared.txt", caption: "Shared caption" });
    const hiddenFile = await attachment(parent.id, second.id, 5);
    const visible = await repository.history(grandchild.id);
    expect(visible.messages.map(m => m.id)).toEqual([first.id, grandOwn.id]);
    expect((await repository.history(child.id)).messages.at(-1)?.attachments[0]).toMatchObject({ id: file.id, name: "shared.txt", caption: "Shared caption" });
    expect((await request(`/api/threads/${grandchild.id}/files/${hiddenFile.id}`)).status).toBe(404);
    const stranger = await thread(2);
    expect((await request(`/api/threads/${stranger.id}/files/${file.id}`)).status).toBe(404);
  });

  it("gates automatic downloads, passes byte limits, and forces active content to downloads", async () => {
    const t = await thread();
    const m = await message(t.id);
    const small = await attachment(t.id, m.id, 5);
    const large = await attachment(t.id, m.id, config.WEB_AUTOLOAD_MAX_BYTES + 1);
    const unknown = await attachment(t.id, m.id, -1);
    const fetch = vi.fn(async () => Buffer.from("hello"));
    resolver.registry.register({ transport: "test", connectionKey: "default", fetch });
    expect((await request(`/api/threads/${t.id}/files/${large.id}?mode=auto`)).status).toBe(413);
    expect((await request(`/api/threads/${t.id}/files/${unknown.id}?mode=auto`)).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    const response = await request(`/api/threads/${t.id}/files/${small.id}?mode=auto`);
    expect(await response.text()).toBe("hello");
    expect(fetch.mock.calls[0]).toHaveLength(3);
    expect((fetch.mock.calls[0] as unknown[])[2]).toBe(config.WEB_AUTOLOAD_MAX_BYTES);
    expect((await request(`/api/threads/${t.id}/files/${large.id}?mode=download`)).status).toBe(200);
    const svg = await attachment(t.id, m.id, 20, "image/svg+xml");
    fetch.mockResolvedValue(Buffer.from('<svg onload="alert(1)"></svg>'));
    const active = await request(`/api/threads/${t.id}/files/${svg.id}?mode=auto`);
    expect(active.headers.get("content-type")).toBe("application/octet-stream");
    expect(active.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(active.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects malformed requests, hides resolver errors, and respects shutdown", async () => {
    expect((await request("/api/users?offset=-1")).status).toBe(400);
    expect((await request("/api/threads/1e3/messages")).status).toBe(400);
    expect((await request("/api/threads/1/messages?before=2&after=3")).status).toBe(400);
    expect((await request("/api/users", { method: "POST" })).status).toBe(405);
    expect((await request("/.env")).status).toBe(404);
    const t = await thread();
    const m = await message(t.id);
    const file = await attachment(t.id, m.id, 10);
    const response = await request(`/api/threads/${t.id}/files/${file.id}`);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("hidden");
    controller.abort();
    expect((await request("/api/users")).status).toBe(503);
    expect(await startWebServer({ config: { ...config, WEB_ENABLED: false }, repository, fileResolver: resolver, logger: createLogger(config), assetsDirectory: "/missing" })).toBeUndefined();
  });
});

it("parses the website flag without treating false as truthy and validates limits", () => {
  const env = { BOT_TOKEN: "test", OPENROUTER_API_KEY: "test", TAVILY_API_KEY: "test", E2B_API_KEY: "test" };
  expect(loadConfig(env).WEB_ENABLED).toBe(false);
  expect(loadConfig({ ...env, WEB_ENABLED: "false" }).WEB_ENABLED).toBe(false);
  expect(loadConfig({ ...env, WEB_ENABLED: "true" }).WEB_ENABLED).toBe(true);
  expect(() => loadConfig({ ...env, WEB_PORT: "65536" })).toThrow();
  expect(() => loadConfig({ ...env, WEB_AUTOLOAD_MAX_BYTES: "-1" })).toThrow();
});
