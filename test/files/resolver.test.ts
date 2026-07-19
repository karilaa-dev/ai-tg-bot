import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { FileByteCache } from "../../src/files/cache.js";
import { FileResolver } from "../../src/files/resolver.js";
import { ManagedFileStore } from "../../src/files/storage.js";
import type { ChatFileSourceAdapter } from "../../src/files/source.js";
import { createLogger } from "../../src/logger.js";

describe("transport-neutral file resolver", () => {
  let db: AppDatabase;
  let repos: Repos;
  let cacheRoot: string;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-resolver-test-"));
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  it("loads a Matrix-style locator through an adapter and caches it for an hour", async () => {
    const user = await repos.users.ensure({ tgId: 901, firstName: "Matrix", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "matrix.txt",
      path: null,
      size: 14,
      contentMd: "remote content",
      isInline: true,
    });
    await repos.files.rememberSource(file.id, {
      transport: "matrix",
      connectionKey: "homeserver",
      remoteKey: "mxc://example/opaque-media-id",
      locator: { mxc: "mxc://example/opaque-media-id", access_token_ref: "matrix-main" },
      mimeType: "text/plain",
    });
    const fetch = vi.fn(async () => Buffer.from("remote content"));
    const adapter: ChatFileSourceAdapter = {
      transport: "matrix",
      connectionKey: "homeserver",
      fetch,
    };
    const resolver = new FileResolver(
      repos.files,
      new FileByteCache({ FILE_CACHE_DIR: cacheRoot, FILE_CACHE_TTL_MS: 3_600_000 }),
      new ManagedFileStore({ BASH_WORKSPACE_ROOT: path.join(cacheRoot, "bash") }),
    );
    resolver.registry.register(adapter);

    const first = await resolver.resolveFile(file);
    const second = await resolver.resolveFile(file);

    expect(first.bytes.toString()).toBe("remote content");
    expect(first.mimeType).toBe("text/plain");
    expect(second.path).toBe(first.path);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.path).toBe(path.join(cacheRoot, "bash", ".chat-files", String(file.id), "content"));
    await expect(repos.files.get(file.id)).resolves.toMatchObject({ path: first.path });
  });

  it("restores one missing managed snapshot without touching sibling sources", async () => {
    const user = await repos.users.ensure({ tgId: 902, firstName: "Restore", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const rows = await Promise.all(["first", "second"].map((name) => repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: `${name}.txt`,
      path: null,
      size: name.length,
      contentMd: name,
      isInline: true,
    })));
    for (const file of rows) {
      await repos.files.rememberSource(file.id, {
        transport: "matrix",
        connectionKey: "homeserver",
        remoteKey: `mxc://example/${file.id}`,
        locator: { mxc: `mxc://example/${file.id}` },
        mimeType: "text/plain",
      });
    }
    const fetch = vi.fn(async (source: Parameters<ChatFileSourceAdapter["fetch"]>[0]) =>
      Buffer.from(source.remoteKey.endsWith(String(rows[0]!.id)) ? "first" : "second"));
    const resolver = new FileResolver(
      repos.files,
      new FileByteCache({ FILE_CACHE_DIR: path.join(cacheRoot, "cache-a"), FILE_CACHE_TTL_MS: 3_600_000 }),
      new ManagedFileStore({ BASH_WORKSPACE_ROOT: path.join(cacheRoot, "bash") }),
    );
    resolver.registry.register({ transport: "matrix", connectionKey: "homeserver", fetch });

    const first = await resolver.resolveFile(rows[0]!);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(repos.files.get(rows[1]!.id)).resolves.toMatchObject({ path: null });
    await fs.rm(path.join(cacheRoot, "bash", ".chat-files"), { recursive: true, force: true });

    const restarted = new FileResolver(
      repos.files,
      new FileByteCache({ FILE_CACHE_DIR: path.join(cacheRoot, "cache-b"), FILE_CACHE_TTL_MS: 3_600_000 }),
      new ManagedFileStore({ BASH_WORKSPACE_ROOT: path.join(cacheRoot, "bash") }),
    );
    restarted.registry.register({ transport: "matrix", connectionKey: "homeserver", fetch });
    const restored = await restarted.resolveFile({ ...rows[0]!, path: first.path });

    expect(restored.bytes.toString()).toBe("first");
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(repos.files.get(rows[1]!.id)).resolves.toMatchObject({ path: null });
    await expect(fs.access(path.join(cacheRoot, "bash", ".chat-files", String(rows[1]!.id), "content")))
      .rejects.toThrow();
  });

  it("shares a concurrent first transport load and serves bytes when persistent writing fails", async () => {
    const user = await repos.users.ensure({ tgId: 903, firstName: "Concurrent", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "shared.txt",
      path: null,
      size: 6,
      contentMd: "shared",
      isInline: true,
    });
    await repos.files.rememberSource(file.id, {
      transport: "matrix",
      connectionKey: "homeserver",
      remoteKey: "mxc://example/shared",
      locator: {},
      mimeType: "text/plain",
    });
    const fetch = vi.fn(async () => Buffer.from("shared"));
    const store = new ManagedFileStore({ BASH_WORKSPACE_ROOT: path.join(cacheRoot, "bash") });
    const resolver = new FileResolver(
      repos.files,
      new FileByteCache({ FILE_CACHE_DIR: path.join(cacheRoot, "cache"), FILE_CACHE_TTL_MS: 3_600_000 }),
      store,
    );
    resolver.registry.register({ transport: "matrix", connectionKey: "homeserver", fetch });

    const [left, right] = await Promise.all([resolver.resolveFile(file), resolver.resolveFile(file)]);
    expect(left.bytes).toEqual(right.bytes);
    expect(fetch).toHaveBeenCalledTimes(1);

    await fs.rm(path.join(cacheRoot, "bash", ".chat-files"), { recursive: true, force: true });
    await repos.files.clearPath(file.id);
    const failingStore = new ManagedFileStore({ BASH_WORKSPACE_ROOT: path.join(cacheRoot, "unwritable") });
    vi.spyOn(failingStore, "write").mockRejectedValue(new Error("disk full"));
    const fallback = new FileResolver(
      repos.files,
      new FileByteCache({ FILE_CACHE_DIR: path.join(cacheRoot, "cache-fallback"), FILE_CACHE_TTL_MS: 3_600_000 }),
      failingStore,
    );
    fallback.registry.register({ transport: "matrix", connectionKey: "homeserver", fetch });

    await expect(fallback.resolveFile({ ...file, path: null })).resolves.toMatchObject({
      bytes: Buffer.from("shared"),
      source: { transport: "matrix" },
    });
    await expect(repos.files.get(file.id)).resolves.toMatchObject({ path: null });
  });

  it("keeps the first file as canonical when the same transport source is claimed twice", async () => {
    const user = await repos.users.ensure({ tgId: 905, firstName: "Canonical", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "file",
      content: {},
      textPlain: "canonical attachment",
    });
    const [first, duplicate] = await Promise.all(["first", "duplicate"].map((name) => repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: `${name}.txt`,
      path: null,
      size: name.length,
      contentMd: name,
      isInline: true,
    })));
    await repos.files.attachToMessage(message.id, first!.id);
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
    await expect(repos.files.listSources(first!.id)).resolves.toHaveLength(1);
    await expect(repos.files.listSources(duplicate!.id)).resolves.toEqual([]);
    await expect(repos.files.listForMessage(message.id)).resolves.toMatchObject([{ id: first!.id }]);
  });

  it("rejects an out-of-store local path instead of exposing arbitrary host files", async () => {
    const user = await repos.users.ensure({ tgId: 904, firstName: "PathSafe", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const outside = path.join(cacheRoot, "outside.txt");
    await fs.writeFile(outside, "private host file");
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "outside.txt",
      path: outside,
      size: 17,
      contentMd: "private host file",
      isInline: true,
    });
    const resolver = new FileResolver(
      repos.files,
      new FileByteCache({ FILE_CACHE_DIR: path.join(cacheRoot, "cache"), FILE_CACHE_TTL_MS: 3_600_000 }),
      new ManagedFileStore({ BASH_WORKSPACE_ROOT: path.join(cacheRoot, "bash") }),
    );

    await expect(resolver.resolveFile(file)).rejects.toThrow("no remote or local source");
    await expect(repos.files.get(file.id)).resolves.toMatchObject({ path: null });
  });
});
