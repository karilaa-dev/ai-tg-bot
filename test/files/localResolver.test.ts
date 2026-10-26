import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { sha256Hex } from "../../src/files/hash.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { FileResolver } from "../../src/files/resolver.js";
import { createLogger } from "../../src/logger.js";
import { webFileSource, WebFileSourceAdapter } from "../../src/web/file-source.js";

describe("local-first durable file resolution", () => {
  let db: AppDatabase;
  let repos: Repos;
  let store: LocalFileStore;
  let resolver: FileResolver;
  let directory: string;
  const original = Buffer.from([0, 255, 1, 13, 10, 0x4d, 0x5a]);

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.initialize();
    repos = createRepos(db.db, db.search);
    directory = await mkdtemp(path.join(os.tmpdir(), "local-resolver-"));
    store = new LocalFileStore(directory);
    resolver = new FileResolver(repos.files, undefined, store);
  });

  it("refuses to report persistence when no local store is configured", async () => {
    const file = await insertFile();
    await expect(new FileResolver(repos.files).persistFile(file, original)).rejects.toThrow("Local file storage is not configured");
    expect(await repos.files.listSources(file.id)).toEqual([]);
  });

  afterEach(async () => {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function insertFile(contentSha256: string | null = sha256Hex(original), size = original.length) {
    const user = await repos.users.ensure({ tgId: 2901 });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    return repos.files.insertFile({
      userId: user.tg_id, threadId: thread.id, name: "../../original.custom", type: "other",
      mimeType: "application/octet-stream", size, contentSha256,
      extractionStatus: "source_only", isInline: false,
    });
  }

  it("persists a file under its UUID and resolves locally after process restart", async () => {
    const file = await insertFile();
    await resolver.persistFile(file, original);
    await repos.files.rememberSource(file.id, { transport: "e2b", connectionKey: "deployment", remoteKey: "gone", locator: {} });
    const unavailable = vi.fn(async () => { throw new Error("Sandbox must not start"); });
    resolver = new FileResolver(repos.files, undefined, new LocalFileStore(directory));
    resolver.registry.register({ transport: "e2b", connectionKey: "deployment", fetch: unavailable });
    expect(await resolver.resolveFile(file, undefined, undefined, { allowSandboxResume: false, pauseAfterRead: false }))
      .toMatchObject({ bytes: original, source: { transport: "local", remoteKey: file.id }, contentSha256: sha256Hex(original) });
    expect(unavailable).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([file.id]);
    expect((await repos.files.get(file.id))?.name).toBe("../../original.custom");
  });

  it("backfills legacy web blobs without needing the blob adapter again", async () => {
    const file = await insertFile(null);
    await db.db.execute(sql`insert into web_file_blobs(file_id, bytes) values (${file.id}, ${original})`);
    await repos.files.rememberSource(file.id, webFileSource(file.id, "application/octet-stream"));
    resolver.registry.register(new WebFileSourceAdapter(db.db));
    expect((await resolver.resolveFile(file)).bytes).toEqual(original);
    expect((await repos.files.get(file.id))?.content_sha256).toBe(sha256Hex(original));
    await db.db.execute(sql`delete from web_file_blobs where file_id = ${file.id}`);
    resolver = new FileResolver(repos.files, undefined, new LocalFileStore(directory));
    expect(await resolver.resolveFile(file)).toMatchObject({ bytes: original, source: { transport: "local" } });
  });

  it("pins the first successful legacy remote download and rejects stale-row overwrites", async () => {
    const file = await insertFile(null);
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "legacy", locator: {} });
    const fetch = vi.fn(async () => original);
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch });
    expect((await resolver.resolveFile(file)).bytes).toEqual(original);
    expect((await resolver.resolveFile(file)).source.transport).toBe("local");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(resolver.persistFile(file, Buffer.alloc(original.length))).rejects.toThrow("hash mismatch");
    expect(await store.read(String(file.id))).toEqual(original);
  });

  it("repairs legacy unknown Telegram sizes while preserving extraction metadata", async () => {
    const file = await insertFile(null, 0);
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "unknown-size", locator: {} });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => original });
    expect((await resolver.resolveFile(file)).bytes).toEqual(original);
    expect(await repos.files.get(file.id)).toMatchObject({
      size: original.length, content_sha256: sha256Hex(original), extraction_status: "source_only", name: file.name,
    });
    expect((await resolver.resolveFile(file)).source.transport).toBe("local");
  });

  it("can finish unknown-size backfill from local bytes after a metadata write failure", async () => {
    const file = await insertFile(null, 0);
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "unknown-size", locator: {} });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => original });
    vi.spyOn(repos.files, "updateExtraction").mockRejectedValueOnce(new Error("Database briefly unavailable"));
    await expect(resolver.resolveFile(file)).rejects.toThrow("Database briefly unavailable");
    resolver = new FileResolver(repos.files, undefined, new LocalFileStore(directory));
    expect(await resolver.resolveFile(file)).toMatchObject({ bytes: original, source: { transport: "local" } });
    expect((await repos.files.get(file.id))?.size).toBe(original.length);
  });

  it("does not reinterpret a known empty file as unknown size", async () => {
    const file = await insertFile(sha256Hex(Buffer.alloc(0)), 0);
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "empty", locator: {} });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => original });
    await expect(resolver.resolveFile(file)).rejects.toThrow("size mismatch");
    expect(await readdir(directory)).toEqual([]);
  });

  it("never replaces the winner when concurrent first legacy downloads disagree", async () => {
    const file = await insertFile(null, 0);
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "racing", locator: {} });
    const alternate = Buffer.alloc(original.length);
    const other = new FileResolver(repos.files, undefined, new LocalFileStore(directory));
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => original });
    other.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => alternate });
    const results = await Promise.allSettled([resolver.resolveFile(file), other.resolveFile(file)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const persisted = await repos.files.get(file.id);
    const bytes = await store.read(String(file.id));
    expect(persisted?.content_sha256).toBe(sha256Hex(bytes));
    expect(bytes.equals(original) || bytes.equals(alternate)).toBe(true);
  });

  it("repairs damaged local bytes using only a matching remote source", async () => {
    const file = await insertFile();
    await resolver.persistFile(file, original);
    await writeFile(path.join(directory, String(file.id)), Buffer.alloc(original.length));
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "original", locator: {} });
    const fetch = vi.fn(async () => original);
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch });
    expect((await resolver.resolveFile(file)).bytes).toEqual(original);
    expect(await store.read(String(file.id))).toEqual(original);
    expect((await resolver.resolveFile(file)).source.transport).toBe("local");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("repairs a substituted local symlink without changing its target", async () => {
    const file = await insertFile();
    await resolver.persistFile(file, original);
    const outside = path.join(directory, "unrelated");
    await writeFile(outside, "private target");
    await rm(path.join(directory, file.id));
    await symlink(outside, path.join(directory, file.id));
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "original", locator: {} });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => original });
    expect((await resolver.resolveFile(file)).bytes).toEqual(original);
    expect((await resolver.resolveFile(file)).source.transport).toBe("local");
    expect(await readFile(outside, "utf8")).toBe("private target");
  });

  it("never serves or caches an altered Telegram representation of the original file", async () => {
    const file = await insertFile();
    await repos.files.rememberSource(file.id, { transport: "telegram", connectionKey: "default", remoteKey: "photo", locator: {} });
    resolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => Buffer.alloc(original.length) });
    await expect(resolver.resolveFile(file)).rejects.toThrow("hash mismatch");
    expect(await readdir(directory)).toEqual([]);
    expect((await repos.files.get(file.id))?.content_sha256).toBe(sha256Hex(original));
  });

  it("enforces a caller's smaller size limit before reading any source", async () => {
    const file = await insertFile();
    await resolver.persistFile(file, original);
    await expect(resolver.resolveFile(file, undefined, original.length - 1)).rejects.toThrow("size limit");
  });
});
