import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/files/hash.js";
import { LocalFileStore } from "../../src/files/localStore.js";
import { LocalFileSourceAdapter } from "../../src/files/localSource.js";

describe("durable local attachment storage", () => {
  let directory: string;
  let store: LocalFileStore;

  beforeEach(async () => {
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
