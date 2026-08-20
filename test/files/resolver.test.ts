import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { FileResolver } from "../../src/files/resolver.js";
import type { ChatFileSourceAdapter } from "../../src/files/source.js";
import { createLogger } from "../../src/logger.js";

describe("transport-neutral file resolver", () => {
  let db: AppDatabase;
  let repos: Repos;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("loads a source directly through its adapter", async () => {
    const file = await insertFile(repos, 901, "matrix.txt");
    await repos.files.rememberSource(file.id, {
      transport: "matrix",
      connectionKey: "homeserver",
      remoteKey: "mxc://example/opaque-media-id",
      locator: { mxc: "mxc://example/opaque-media-id" },
      mimeType: "text/plain",
    });
    const fetch = vi.fn(async () => Buffer.from("remote content"));
    const resolver = createResolver(repos);
    resolver.registry.register({ transport: "matrix", connectionKey: "homeserver", fetch });

    const first = await resolver.resolveFile(file);

    expect(first.bytes.toString()).toBe("remote content");
    expect(first.mimeType).toBe("text/plain");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls through an unavailable source to the next durable source", async () => {
    const file = await insertFile(repos, 902, "fallback.txt");
    await repos.files.rememberSource(file.id, {
      transport: "e2b",
      connectionKey: "deployment",
      remoteKey: "sandbox:/home/user/workspace/fallback.txt",
      locator: {},
      mimeType: "text/plain",
    });
    await repos.files.rememberSource(file.id, {
      transport: "telegram",
      connectionKey: "default",
      remoteKey: "telegram-unique",
      locator: { file_id: "BQAC-fallback" },
      mimeType: "text/plain",
    });
    const resolver = createResolver(repos);
    resolver.registry.register({
      transport: "e2b",
      connectionKey: "deployment",
      fetch: async () => Buffer.from("remote content"),
    });
    resolver.registry.register({
      transport: "telegram",
      connectionKey: "default",
      fetch: async () => { throw new Error("Telegram unavailable"); },
    });

    await expect(resolver.resolveFile(file)).resolves.toMatchObject({
      bytes: Buffer.from("remote content"),
      source: { transport: "e2b" },
    });
  });

  it("prefers the byte-exact E2B source without touching Telegram", async () => {
    const file = await insertFile(repos, 905, "e2b-first.txt");
    await repos.files.rememberSource(file.id, {
      transport: "e2b",
      connectionKey: "deployment",
      remoteKey: "sandbox:file:1",
      locator: {},
      mimeType: "text/plain",
    });
    await repos.files.rememberSource(file.id, {
      transport: "telegram",
      connectionKey: "default",
      remoteKey: "telegram-first",
      locator: { file_id: "BQAC-first" },
      mimeType: "text/plain",
    });
    const e2bFetch = vi.fn(async () => Buffer.from("remote content"));
    const telegramFetch = vi.fn(async () => Buffer.from("telegram re-encoded content"));
    const resolver = createResolver(repos);
    resolver.registry.register({ transport: "e2b", connectionKey: "deployment", fetch: e2bFetch });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: telegramFetch });

    await expect(resolver.resolveFile(file)).resolves.toMatchObject({
      bytes: Buffer.from("remote content"),
      source: { transport: "e2b" },
    });
    expect(e2bFetch).toHaveBeenCalledOnce();
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("rejects stale E2B bytes and falls through to another durable source", async () => {
    const expected = Buffer.from("remote content");
    const file = await insertFile(
      repos,
      906,
      "integrity.txt",
      createHash("sha256").update(expected).digest("hex"),
    );
    await repos.files.rememberSource(file.id, {
      transport: "e2b",
      connectionKey: "deployment",
      remoteKey: "sandbox:file:integrity",
      locator: {},
      mimeType: "text/plain",
    });
    await repos.files.rememberSource(file.id, {
      transport: "matrix",
      connectionKey: "homeserver",
      remoteKey: "mxc://example/integrity",
      locator: {},
      mimeType: "text/plain",
    });
    const resolver = createResolver(repos);
    resolver.registry.register({
      transport: "e2b",
      connectionKey: "deployment",
      fetch: async () => Buffer.from("stale contents"),
    });
    resolver.registry.register({
      transport: "matrix",
      connectionKey: "homeserver",
      fetch: async () => expected,
    });

    await expect(resolver.resolveFile(file)).resolves.toMatchObject({
      bytes: expected,
      source: { transport: "matrix" },
    });
  });

  it("reports files with no durable source without reading arbitrary host paths", async () => {
    const file = await insertFile(repos, 903, "missing.txt");
    const resolver = createResolver(repos);

    await expect(resolver.resolveFile(file)).rejects.toThrow(`File #${file.id} has no durable source`);
  });

  it("keeps the first file canonical when the same remote source is claimed twice", async () => {
    const user = await repos.users.ensure({ tgId: 904, firstName: "Canonical", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const [first, duplicate] = await Promise.all(["first", "duplicate"].map((name) => repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: `${name}.txt`,
      size: name.length,
      contentMd: name,
      isInline: true,
    })));
    const source = {
      transport: "telegram",
      connectionKey: "default",
      remoteKey: "stable-unique-id",
      locator: { file_id: "BQAC-first", file_unique_id: "stable-unique-id" },
      mimeType: "text/plain",
    };

    const canonical = await repos.files.rememberSource(first!.id, source);
    const raced = await repos.files.rememberSource(duplicate!.id, {
      ...source,
      locator: { file_id: "BQAC-newer", file_unique_id: "stable-unique-id" },
    });

    expect(raced.file_id).toBe(canonical.file_id);
    expect(raced.file_id).toBe(first!.id);
    expect(JSON.parse(raced.locator_json)).toMatchObject({ file_id: "BQAC-newer" });
    await expect(repos.files.listSources(duplicate!.id)).resolves.toEqual([]);
  });
});

function createResolver(repos: Repos): FileResolver {
  return new FileResolver(repos.files);
}

async function insertFile(repos: Repos, tgId: number, name: string, contentSha256?: string) {
  const user = await repos.users.ensure({ tgId, firstName: "Files", lang: "en" });
  const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
  return repos.files.insertFile({
    userId: user.tg_id,
    threadId: thread.id,
    type: "txt",
    contentSha256,
    name,
    size: 14,
    contentMd: "remote content",
    isInline: true,
  });
}
