import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { SandboxConsentRequired } from "../../src/files/source.js";
import { FileResolver } from "../../src/files/resolver.js";
import { createLogger } from "../../src/logger.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createWebHandler, startWebServer } from "../../src/web/server.js";
import { audioFixture } from "../helpers/audio.js";
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
    repository = new ConversationRepository(database.db, repos, 99);
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

  it("hides existing bot records from lists, search, and direct history access", async () => {
    const botThread = await thread(99);
    await thread(1);
    expect((await repository.users("", 0)).items.map(u => u.id)).toEqual([1]);
    for (const query of ["99", "Person 99"]) expect((await repository.users(query, 0)).items).toEqual([]);
    expect((await request("/api/users/99/threads")).status).toBe(404);
    expect((await request(`/api/threads/${botThread.id}/messages`)).status).toBe(404);
    expect(await repos.users.get(99)).toBeDefined();
  });

  it("requires explicit manual sandbox consent and tries non-sandbox copies first", async () => {
    const t = await thread();
    const m = await message(t.id);
    const file = await attachment(t.id, m.id, 5);
    const e2b = vi.fn(async (_source, _signal, _max, policy) => {
      if (!policy.allowSandboxResume) throw new SandboxConsentRequired();
      return Buffer.from("hello");
    });
    resolver.registry.register({ transport: "e2b", connectionKey: "default", fetch: e2b });
    await repos.files.rememberSource(file.id, { transport: "e2b", connectionKey: "default", remoteKey: "sandbox", locator: {} });
    const url = `/api/threads/${t.id}/files/${file.id}`;
    const pending = await request(`${url}?mode=auto`);
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "sandbox_consent_required" });
    expect((await request(`${url}?mode=download`)).status).toBe(409);
    expect((await request(`${url}?mode=auto&sandbox=start`)).status).toBe(400);
    expect((await request(`${url}?sandbox=no`)).status).toBe(400);
    expect(await (await request(`${url}?mode=download&sandbox=start`)).text()).toBe("hello");
    expect(e2b.mock.calls.at(-1)?.[3]).toEqual({ allowSandboxResume: true, pauseAfterRead: true });
    e2b.mockClear();
    resolver.registry.register({ transport: "test", connectionKey: "default", fetch: async () => Buffer.from("hello") });
    expect(await (await request(`${url}?mode=auto`)).text()).toBe("hello");
    expect(e2b).not.toHaveBeenCalled();
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
    expect(fetch.mock.calls[0]).toHaveLength(4);
    expect((fetch.mock.calls[0] as unknown[])[2]).toBe(config.WEB_AUTOLOAD_MAX_BYTES);
    expect((await request(`/api/threads/${t.id}/files/${large.id}?mode=download`)).status).toBe(200);
    const svg = await attachment(t.id, m.id, 20, "image/svg+xml");
    fetch.mockResolvedValue(Buffer.from('<svg onload="alert(1)"></svg>'));
    const active = await request(`/api/threads/${t.id}/files/${svg.id}?mode=auto`);
    expect(active.headers.get("content-type")).toBe("application/octet-stream");
    expect(active.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(active.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(["ogg", "mp3", "wav", "m4a", "flac", "aac", "webm"] as const)("serves detected %s audio for automatic playback", async format => {
    const t = await thread();
    const m = await message(t.id);
    const bytes = audioFixture(format);
    const file = await attachment(t.id, m.id, bytes.length, "audio/ogg");
    resolver.registry.register({ transport: "test", connectionKey: "default", fetch: async () => bytes });
    const response = await request(`/api/threads/${t.id}/files/${file.id}?mode=auto`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^audio\//);
    expect(response.headers.get("content-disposition")).toMatch(/^inline/);
    expect(response.headers.get("content-security-policy")).toContain("media-src 'self' blob:");
  });

  it("reads full saved audio transcripts only at their visible message", async () => {
    const t = await thread();
    const m = await repos.messages.insert({ threadId: t.id, role: "user", kind: "file", content: {}, textPlain: "" });
    const file = await repos.files.insertFile({ userId: 1, threadId: t.id, messageId: m.id, type: "audio", name: "voice.ogg", mimeType: "audio/ogg", size: 500, isInline: false });
    const id = await repos.audioTranscripts.insert({ userId: 1, threadId: t.id, messageId: m.id, fileId: file.id }, { text: "Full saved speech", model: "test" });
    const text = `Preview\n\n[[chat-file:${file.id}]] [Audio transcript preview; full transcript saved (9000 characters). Read more with transcribe_audio(${JSON.stringify({ transcript_id: id, offset: 8000 })}).]`;
    await database.db.execute(sql`update messages set text_plain = ${text} where id = ${m.id}`);
    expect((await repository.history(t.id)).messages[0]?.attachments[0]?.transcription).toBe("Full saved speech");
    const earlier = await repos.messages.insert({ threadId: t.id, role: "user", kind: "file", content: {}, textPlain: text });
    await repos.files.attachToMessage(earlier.id, file.id);
    expect((await repository.history(t.id)).messages[1]?.attachments[0]).toMatchObject({ transcription: "Preview", transcriptionTruncated: true });
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
