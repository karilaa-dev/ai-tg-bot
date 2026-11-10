import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/files/hash.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { LocalFileSourceAdapter } from "../../src/files/localSource.js";

// Observes physical writes while every call still reaches the real filesystem.
vi.mock("node:fs/promises", async importOriginal => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, open: vi.fn(filesystem.open), link: vi.fn(filesystem.link), rename: vi.fn(filesystem.rename) };
});

describe("durable local attachment storage", () => {
  let directory: string;
  let store: LocalFileStore;

  /** Staging files created inside the store, each of which is fully written and fsynced before publication. */
  const stagingWrites = () => vi.mocked(open).mock.calls.filter(([file, flags]) =>
    flags === "wx" && String(file).startsWith(store.rootDirectory)).length;
  const publications = () => vi.mocked(link).mock.calls.length;

  beforeEach(async () => {
    vi.mocked(open).mockClear();
    vi.mocked(link).mockClear();
    directory = await mkdtemp(path.join(os.tmpdir(), "ai-tg-files-"));
    store = new LocalFileStore(path.join(directory, "files"));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("retains arbitrary original bytes across restarts in a private UUID filename", async () => {
    const id = randomUUID();
    const bytes = Buffer.from([0, 0xff, 13, 10, 0x50, 0x4b]);
    expect(await store.write(id, bytes)).toEqual({ size: bytes.length, contentSha256: sha256Hex(bytes) });
    await store.write(id, bytes);
    expect(await readdir(store.rootDirectory)).toEqual([id]);
    expect((await stat(path.join(store.rootDirectory, id))).mode & 0o777).toBe(0o600);
    expect(await new LocalFileStore(store.rootDirectory).read(id)).toEqual(bytes);
  });

  it.each(["../outside", "/tmp/outside", "name.pdf", "12", "", `${randomUUID()}/../outside`])("rejects a non-UUID key %j before creating paths", async key => {
    await expect(store.write(key, Buffer.from("data"))).rejects.toThrow("UUID");
    await expect(store.read(key)).rejects.toThrow("UUID");
    expect(await readdir(directory)).toEqual([]);
  });

  it("never follows an attachment symlink or reads a directory", async () => {
    await mkdir(store.rootDirectory);
    const outside = path.join(directory, "outside");
    await writeFile(outside, "private");
    const id = randomUUID();
    await symlink(outside, path.join(store.rootDirectory, id));
    await expect(store.read(id)).rejects.toThrow();
    await expect(store.write(id, Buffer.from("replacement"))).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("private");
    const directoryId = randomUUID();
    await mkdir(path.join(store.rootDirectory, directoryId));
    await expect(store.read(directoryId)).rejects.toThrow("regular file");
  });

  it("enforces download limits before allocating attachment bytes", async () => {
    const id = randomUUID();
    await store.write(id, Buffer.from("12345"));
    await expect(store.read(id, undefined, 4)).rejects.toThrow("size limit");
    expect(await store.read(id, undefined, 5)).toEqual(Buffer.from("12345"));
  });

  it("publishes one complete file when different writers race and cleans staging files", async () => {
    const id = randomUUID();
    const a = Buffer.alloc(100_000, 0x41);
    const b = Buffer.alloc(100_000, 0x42);
    const results = await Promise.allSettled([store.write(id, a), store.write(id, b)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const bytes = await store.read(id);
    expect(bytes.equals(a) || bytes.equals(b)).toBe(true);
    expect(await readdir(store.rootDirectory)).toEqual([id]);
  });

  it("does not rewrite or republish identical bytes that are already stored", async () => {
    const id = randomUUID();
    const bytes = Buffer.from("same canonical bytes");
    const first = await store.write(id, bytes);
    expect([stagingWrites(), publications()]).toEqual([1, 1]);
    const again = await Promise.all([store.write(id, bytes), store.write(id, Buffer.from(bytes))]);
    expect(again).toEqual([first, first]);
    // No second temporary copy was written, fsynced or linked.
    expect([stagingWrites(), publications()]).toEqual([1, 1]);
    expect(await readdir(store.rootDirectory)).toEqual([id]);
    expect((await stat(path.join(store.rootDirectory, id))).mode & 0o777).toBe(0o600);
  });

  it("still publishes when the stored bytes are missing and conflicts on different or damaged bytes", async () => {
    const id = randomUUID();
    const bytes = Buffer.from("original bytes");
    await store.write(id, bytes);
    await expect(store.write(id, Buffer.from("different data"))).rejects.toThrow("different bytes");
    // Same size, different content is damage, never proof of an intact copy.
    await writeFile(path.join(store.rootDirectory, id), "damaged  bytes!");
    await expect(store.write(id, bytes)).rejects.toThrow("different bytes");
    await writeFile(path.join(store.rootDirectory, id), "short");
    await expect(store.write(id, bytes)).rejects.toThrow("different bytes");
    await writeFile(path.join(store.rootDirectory, id), Buffer.concat([bytes, Buffer.from(" and more")]));
    await expect(store.write(id, bytes)).rejects.toThrow("different bytes");
    expect(await readdir(store.rootDirectory)).toEqual([id]);
    await rm(path.join(store.rootDirectory, id));
    const before = stagingWrites();
    await store.write(id, bytes);
    expect(stagingWrites()).toBe(before + 1);
    expect(await store.read(id)).toEqual(bytes);
  });

  it("honors cancellation on the already-stored path without touching the file", async () => {
    const id = randomUUID();
    const bytes = Buffer.from("intact");
    await store.write(id, bytes);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(store.write(id, bytes, controller.signal)).rejects.toThrow("cancelled");
    expect(await store.read(id)).toEqual(bytes);
    expect(stagingWrites()).toBe(1);
  });

  it("never treats a directory or symlink at the destination as stored bytes", async () => {
    await mkdir(store.rootDirectory);
    const directoryId = randomUUID();
    await mkdir(path.join(store.rootDirectory, directoryId));
    await expect(store.write(directoryId, Buffer.from("data"))).rejects.toThrow("regular file");
    const outside = path.join(directory, "outside");
    await writeFile(outside, "data");
    const linkedId = randomUUID();
    await symlink(outside, path.join(store.rootDirectory, linkedId));
    // Even a link to identical bytes is not an intact canonical file.
    await expect(store.write(linkedId, Buffer.from("data"))).rejects.toThrow("different bytes");
    expect(stagingWrites()).toBe(0);
    expect((await readdir(store.rootDirectory)).sort()).toEqual([directoryId, linkedId].sort());
  });

  it("agrees on one canonical file when matching and conflicting writers race the same key", async () => {
    const id = randomUUID();
    const a = Buffer.alloc(50_000, 0x41);
    const b = Buffer.alloc(50_000, 0x42);
    const results = await Promise.allSettled([store.write(id, a), store.write(id, Buffer.from(a)), store.write(id, b), store.write(id, Buffer.from(b))]);
    const winner = (await store.read(id)).equals(a) ? a : b;
    expect(results.map(result => result.status)).toEqual(winner === a ? ["fulfilled", "fulfilled", "rejected", "rejected"] : ["rejected", "rejected", "fulfilled", "fulfilled"]);
    expect(await store.read(id)).toEqual(winner);
    expect(await readdir(store.rootDirectory)).toEqual([id]);
  });

  it("keeps a verified canonical file and publishes nothing new after a restart", async () => {
    const id = randomUUID();
    const bytes = Buffer.from("survives restart");
    await store.write(id, bytes);
    vi.mocked(open).mockClear();
    vi.mocked(link).mockClear();
    const restarted = new LocalFileStore(store.rootDirectory);
    expect(await restarted.write(id, bytes)).toEqual({ size: bytes.length, contentSha256: sha256Hex(bytes) });
    expect([stagingWrites(), publications()]).toEqual([0, 0]);
  });

  it("does not publish or leave temporary bytes after cancellation", async () => {
    const id = randomUUID();
    const controller = new AbortController();
    const writing = store.write(id, Buffer.alloc(1_000_000), controller.signal);
    controller.abort();
    await expect(writing).rejects.toThrow();
    expect(await readdir(store.rootDirectory)).toEqual([]);
  });

  it("repairs corrupted bytes only with verified original size and hash", async () => {
    const id = randomUUID();
    const original = Buffer.from("original");
    const integrity = await store.write(id, original);
    await writeFile(path.join(store.rootDirectory, id), "damaged!");
    await expect(store.repair(id, Buffer.from("forged!!"), integrity)).rejects.toThrow("hash mismatch");
    await store.repair(id, original, integrity);
    expect(await store.read(id)).toEqual(original);
    expect(await readdir(store.rootDirectory)).toEqual([id]);
  });

  it("validates local source metadata and ignores locator paths", async () => {
    const id = randomUUID();
    const bytes = Buffer.from("original");
    const integrity = await store.write(id, bytes);
    const source = {
      transport: "local", connectionKey: "default", remoteKey: id,
      locator: { size: integrity.size, sha256: integrity.contentSha256, path: "/etc/passwd" },
    };
    const adapter = new LocalFileSourceAdapter(store);
    expect(await adapter.fetch(source)).toEqual(bytes);
    await writeFile(path.join(store.rootDirectory, id), "modified");
    await expect(adapter.fetch(source)).rejects.toThrow("hash mismatch");
    await expect(adapter.fetch({ ...source, locator: {} })).rejects.toThrow();
  });
});
