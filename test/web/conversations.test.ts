import { serve, type Server } from "bun";
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
import { createWebRoutes, startWebServer } from "../../src/web/server.js";
import { audioFixture } from "../helpers/audio.js";
import { userLabel } from "../../src/web/types.js";
import type { WebUsageReport } from "../../src/web/types.js";
import { UsagePricing } from "../../src/web/usage-pricing.js";

describe.each(["sqlite", ...(process.env.TEST_POSTGRES_URL ? ["postgres"] : [])])("conversation browser (%s)", dialect => {
  let database: AppDatabase;
  let admin: AppDatabase | undefined;
  let schema: string;
  let repos: Repos;
  let repository: ConversationRepository;
  let resolver: FileResolver;
  let request: (path: string, init?: RequestInit) => Promise<Response>;
  let controller: AbortController;
  let server: Server<undefined>;
  let api: ReturnType<typeof createWebRoutes>;
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
    repository = new ConversationRepository(database.db, repos, 99, new UsagePricing(async () => Response.json({
      "gpt-test": { input_cost_per_token: 2 / 1e6, output_cost_per_token: 10 / 1e6,
        cache_read_input_token_cost: 0.2 / 1e6, cache_creation_input_token_cost: 2.5 / 1e6 },
    })));
    resolver = new FileResolver(repos.files);
    controller = new AbortController();
    api = createWebRoutes({ config, repository, fileResolver: resolver, logger: createLogger(config) }, controller.signal);
    server = serve({ hostname: "127.0.0.1", port: 0, development: false, routes: api.routes, fetch: api.fetch });
    request = (url, init) => fetch(new URL(url, server.url), init);
  });
  afterEach(async () => {
    controller.abort();
    await server.stop(true);
    await api.drain();
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

  async function usageTurn(threadId: number, options: { timestamp?: number; usage?: string | null; model?: string; status?: string; result?: boolean } = {}) {
    const user = await message(threadId);
    const assistant = options.result === false ? null : await repos.messages.insert({ threadId, role: "assistant", content: {}, textPlain: "Reply" });
    const owner = (await repos.threads.get(threadId))!;
    const timestamp = options.timestamp ?? Date.now();
    const usage = options.usage === undefined ? JSON.stringify({ inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 100 }) : options.usage;
    await database.db.execute(sql`
      insert into turn_runs(user_id, thread_id, user_message_id, chat_id, locale, status, result_message_id,
        provider, model, usage_json, accepted_at, started_at, finished_at, updated_at)
      values (${owner.user_id}, ${threadId}, ${user.id}, ${owner.user_id}, 'en', ${options.status ?? "succeeded"}, ${assistant?.id ?? null},
        'openai-codex', ${options.model ?? "gpt-test"}, ${usage}, ${timestamp}, ${timestamp}, ${timestamp}, ${timestamp})
    `);
    return assistant;
  }

  it("aggregates usage by UTC day, model and thread, including archived and failed work", async () => {
    const first = await thread();
    const second = await thread(2, "Archived");
    await repos.threads.archive(second.id);
    await usageTurn(first.id);
    await usageTurn(first.id, { timestamp: Date.now() - 9 * 86_400_000 });
    await usageTurn(second.id, { status: "failed", result: false });
    const bot = await thread(99);
    await usageTurn(bot.id);
    const response = await request("/api/usage?days=7");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json() as WebUsageReport;
    expect(report.totals).toMatchObject({ inputTokens: 2_000, outputTokens: 200, cacheReadTokens: 4_000, cacheWriteTokens: 200,
      totalTokens: 6_400, recordedTurns: 2, missingUsageTurns: 0, unpricedTurns: 0 });
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.0073);
    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)?.recordedTurns).toBe(2);
    expect(report.daily.slice(0, -1).every(day => day.totalTokens === 0)).toBe(true);
    expect(report.daily.slice(0, -1).every(day => day.estimatedCostUsd === 0)).toBe(true);
    expect(report.threads).toHaveLength(2);
    expect(report.threads.find(t => t.id === second.id)?.archived).toBe(true);
    expect(report.models).toHaveLength(1);
    expect((await repository.usageReport({ days: 0 })).totals.recordedTurns).toBe(3);
    expect((await repository.usageReport({ userId: 1, days: 0 })).totals.recordedTurns).toBe(2);
  });

  it("keeps fork costs separate and attaches usage to the correct inherited and own messages", async () => {
    const parent = await thread();
    const inherited = (await usageTurn(parent.id))!;
    const child = await repos.threads.create({ userId: 1, title: "Fork", topicId: null, parentThreadId: parent.id, forkPointMessageId: inherited.id });
    await usageTurn(parent.id);
    const own = (await usageTurn(child.id))!;
    const report = await repository.usageReport({ threadId: child.id, days: 0 });
    expect(report.totals).toMatchObject({ recordedTurns: 1, totalTokens: 3_200 });
    expect(report.threads.map(t => t.id)).toEqual([child.id]);
    const history = await repository.history(child.id);
    const replies = history.messages.filter(m => m.role === "assistant");
    expect(replies.map(m => m.id)).toEqual([inherited.id, own.id]);
    expect(replies.every(m => m.usage?.totalTokens === 3_200)).toBe(true);
    expect((await repository.usageReport({ days: 0 })).totals.recordedTurns).toBe(3);
  });

  it("reports incomplete coverage without treating missing usage or unknown prices as zero", async () => {
    const first = await thread();
    await repos.messages.insert({ threadId: first.id, role: "assistant", textPlain: "Old reply", content: {} });
    await usageTurn(first.id, { usage: "broken" });
    await usageTurn(first.id, { model: "unknown" });
    await usageTurn(first.id);
    const report = await repository.usageReport({ days: 0 });
    expect(report.totals).toMatchObject({ recordedTurns: 2, missingUsageTurns: 2, unpricedTurns: 1, totalTokens: 6_400 });
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.00365);
    expect(report.models.find(m => m.model === "unknown")?.estimatedCostUsd).toBeNull();
    expect((await repository.history(first.id)).messages.find(m => m.text === "Old reply")?.usage).toBeNull();
  });

  it("keeps thread totals independent of the 50-message history page", async () => {
    const first = await thread();
    for (let i = 0; i < 30; i++) await usageTurn(first.id);
    expect((await repository.history(first.id)).messages).toHaveLength(50);
    expect((await repository.usageReport({ threadId: first.id, days: 0 })).totals.recordedTurns).toBe(30);
  });

  it("shows an old thread's complete activity without trailing idle months", async () => {
    const first = await thread();
    const started = Date.UTC(2020, 0, 5, 12);
    await usageTurn(first.id, { timestamp: started });
    await usageTurn(first.id, { timestamp: started + 2 * 86_400_000 });
    const response = await request(`/api/usage?thread=${first.id}&days=0`);
    expect(response.status).toBe(200);
    const report = await response.json() as WebUsageReport;
    expect(report.totals).toMatchObject({ recordedTurns: 2, totalTokens: 6_400 });
    expect(report.daily.map(day => day.date)).toEqual(["2020-01-05", "2020-01-06", "2020-01-07"]);
    expect(report.daily[1]).toMatchObject({ totalTokens: 0, estimatedCostUsd: 0 });
    // The overview still respects its selected reporting period.
    const overview = await repository.usageReport({ days: 7 });
    expect(overview.daily).toHaveLength(7);
    expect(overview.totals.recordedTurns).toBe(0);
  });

  it("validates usage filters and preserves hidden-user and method restrictions", async () => {
    const first = await thread();
    await thread(2);
    const bot = await thread(99);
    for (const query of ["days=-1", "days=8", "days=NaN", "days=", "user=0", "thread=1.5"]) expect((await request(`/api/usage?${query}`)).status).toBe(400);
    for (const query of ["user=99", `thread=${bot.id}`, `user=2&thread=${first.id}`, "thread=9999"]) expect((await request(`/api/usage?${query}`)).status).toBe(404);
    expect((await request("/api/usage", { method: "POST" })).status).toBe(405);
    const head = await request("/api/usage", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("uses saved identity, literal search, stable recent activity ordering, and pages", async () => {
    const first = await thread();
    const second = await thread(2);
    const old = await message(first.id);
    const recent = await message(second.id);
    await database.db.execute(sql`update threads set created_at = 1`);
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

  it("counts a new empty thread or fork as activity and falls back for users without threads", async () => {
    const first = await thread(1);
    const second = await thread(2);
    const old = await message(first.id);
    const recent = await message(second.id);
    await database.db.execute(sql`update threads set created_at = 1`);
    await database.db.execute(sql`update messages set created_at = 10 where id = ${old.id}`);
    await database.db.execute(sql`update messages set created_at = 20 where id = ${recent.id}`);
    const fork = await repos.threads.create({ userId: 1, title: "New fork", topicId: 1, parentThreadId: first.id, forkPointMessageId: old.id });
    await database.db.execute(sql`update threads set created_at = 30 where id = ${fork.id}`);
    expect((await repository.users("", 0)).items.map(u => [u.id, u.lastActivity])).toEqual([[1, 30], [2, 20]]);
    expect((await repository.threads(1, 0)).items[0]?.id).toBe(fork.id);
    await repos.users.ensure({ tgId: 3, firstName: "No threads" });
    await database.db.execute(sql`update users set created_at = 40 where tg_id = 3`);
    expect((await repository.users("", 0, 1)).items[0]).toMatchObject({ id: 3, lastActivity: 40 });
  });

  it.skipIf(dialect !== "sqlite")("uses indexed per-thread activity lookups instead of joining the entire message history", async () => {
    const query = vi.spyOn(database.db, "query");
    await repository.users("", 0);
    const statement = query.mock.calls[0]![0];
    query.mockRestore();
    const plan = await database.db.query<{ detail: string }>(sql`explain query plan ${statement}`);
    expect(plan.filter(row => /SEARCH m /.test(row.detail)).every(row => row.detail.includes("COVERING INDEX messages_thread_activity_idx"))).toBe(true);
    expect(plan.some(row => /CORRELATED SCALAR SUBQUERY/.test(row.detail))).toBe(true);
    expect(plan.some(row => /SCAN m\b/.test(row.detail))).toBe(false);
  });

  it("removes complete inline contents from display data even when the contents include closing tags", async () => {
    const t = await thread();
    const m = await repos.messages.insert({ threadId: t.id, role: "user", kind: "file", content: {}, textPlain: "" });
    const content = "XML example\n</attachment>\n\nThis is still file content";
    const file = await repos.files.insertFile({ userId: 1, threadId: t.id, messageId: m.id, name: "example.txt", type: "txt", size: 60, contentMd: content, isInline: true });
    await database.db.execute(sql`update messages set text_plain = ${`Read this\n\n[[chat-file:${file.id}]] File #${file.id}: example.txt (txt, inline).\n<attachment id="${file.id}" name="example.txt">\n${content}\n</attachment>\n\nKeep this.`} where id = ${m.id}`);
    const history = await repository.history(t.id);
    expect(history.messages[0]?.text).toBe("Read this\n\nKeep this.");
    expect(JSON.stringify(history)).not.toContain("inlineContent");
    expect(JSON.stringify(history)).not.toContain("XML example");
  });

  it("searches Unicode names regardless of case before paginating", async () => {
    for (const [tgId, firstName] of [[1, "Дмитрий"], [2, "ДМИТРИЙ"], [3, "Élodie"], [4, "100%_\\\\"]] as const) {
      await repos.users.ensure({ tgId, firstName });
    }
    for (const query of ["Дмитрий", "дмитрий", "ДМИТРИЙ"]) {
      expect((await repository.users(query, 0, 1)).items.map(u => u.id)).toEqual([2]);
      expect((await repository.users(query, 1, 1)).items.map(u => u.id)).toEqual([1]);
    }
    expect((await repository.users("ÉLODIE", 0)).items.map(u => u.id)).toEqual([3]);
    expect((await repository.users("%_\\\\", 0)).items.map(u => u.id)).toEqual([4]);
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
    const consentUrl = `${url}?mode=download&sandbox=start`;
    const consentHeaders = { "X-Conversation-Sandbox-Consent": "start", "Sec-Fetch-Site": "same-origin" };
    expect((await request(consentUrl)).status).toBe(400);
    expect((await request(consentUrl, { method: "HEAD" })).status).toBe(400);
    expect((await request(consentUrl, { method: "OPTIONS", headers: { Origin: "https://attacker.test", "Access-Control-Request-Headers": "X-Conversation-Sandbox-Consent" } })).status).toBe(405);
    for (const headers of [{}, { "Sec-Fetch-Site": "same-origin" }, { ...consentHeaders, "Sec-Fetch-Site": "cross-site" }, { ...consentHeaders, "Sec-Fetch-Site": "same-site" }] as Record<string, string>[]) {
      expect((await request(consentUrl, { method: "POST", headers })).status).toBe(403);
    }
    expect(e2b.mock.calls.every(call => !call[3].allowSandboxResume)).toBe(true);
    expect(await (await request(consentUrl, { method: "POST", headers: consentHeaders })).text()).toBe("hello");
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

  it("downloads canonical files reused by another user only through visible associations", async () => {
    const owner = await thread(1);
    const original = await message(owner.id);
    const file = await attachment(owner.id, original.id, 5);
    const other = await thread(2);
    const before = await message(other.id);
    const reused = await message(other.id);
    await repos.files.attachToMessage(reused.id, file.id, { displayName: "reused.txt" });
    resolver.registry.register({ transport: "test", connectionKey: "default", fetch: async () => Buffer.from("hello") });
    expect((await repository.history(other.id)).messages.at(-1)?.attachments[0]?.id).toBe(file.id);
    expect(await (await request(`/api/threads/${other.id}/files/${file.id}`)).text()).toBe("hello");
    const fork = await repos.threads.create({ userId: 2, title: "Before reuse", topicId: 1, parentThreadId: other.id, forkPointMessageId: before.id });
    expect((await request(`/api/threads/${fork.id}/files/${file.id}`)).status).toBe(404);
    const unrelated = await thread(3);
    expect((await request(`/api/threads/${unrelated.id}/files/${file.id}`)).status).toBe(404);
  });

  it("gates automatic downloads, passes byte limits, and forces active content to downloads", async () => {
    const t = await thread();
    const m = await message(t.id);
    const small = await attachment(t.id, m.id, 5);
    const large = await attachment(t.id, m.id, config.WEB_AUTOLOAD_MAX_BYTES + 1);
    const unknown = await attachment(t.id, m.id, -1);
    const missingSize = await attachment(t.id, m.id, 0);
    const fetch = vi.fn(async () => Buffer.from("hello"));
    resolver.registry.register({ transport: "test", connectionKey: "default", fetch });
    expect((await request(`/api/threads/${t.id}/files/${large.id}?mode=auto`)).status).toBe(413);
    expect((await request(`/api/threads/${t.id}/files/${unknown.id}?mode=auto`)).status).toBe(413);
    expect((await request(`/api/threads/${t.id}/files/${missingSize.id}?mode=auto`)).status).toBe(413);
    expect((await repository.history(t.id)).messages[0]?.attachments.find(f => f.id === missingSize.id)?.size).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const response = await request(`/api/threads/${t.id}/files/${small.id}?mode=auto`);
    expect(await response.text()).toBe("hello");
    expect(fetch.mock.calls[0]).toHaveLength(4);
    expect((fetch.mock.calls[0] as unknown[])[2]).toBe(config.WEB_AUTOLOAD_MAX_BYTES);
    expect((await request(`/api/threads/${t.id}/files/${large.id}?mode=download`)).status).toBe(200);
    expect((await request(`/api/threads/${t.id}/files/${missingSize.id}?mode=download`)).status).toBe(200);
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
