import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileByteCache } from "../../src/files/cache.js";

describe("chat file byte cache", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("deduplicates concurrent loads and uses an opaque cache path", async () => {
    const root = await temporaryRoot();
    const cache = new FileByteCache({ FILE_CACHE_DIR: root, FILE_CACHE_TTL_MS: 3_600_000 });
    const loader = vi.fn(async () => Buffer.from("matrix attachment"));
    const identity = "matrix\0primary\0mxc://server/private-secret";

    const [first, second] = await Promise.all([
      cache.getOrLoad(identity, loader),
      cache.getOrLoad(identity, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.path).toBe(second.path);
    expect(first.bytes.toString()).toBe("matrix attachment");
    expect(path.basename(first.path)).toMatch(/^[a-f0-9]{64}$/);
    expect(first.path).not.toContain("private-secret");
    await expect(cache.get(identity)).resolves.toMatchObject({
      path: first.path,
      bytes: Buffer.from("matrix attachment"),
    });
  });

  it("reloads expired entries and sweeps abandoned partial files", async () => {
    const root = await temporaryRoot();
    const cache = new FileByteCache({ FILE_CACHE_DIR: root, FILE_CACHE_TTL_MS: 1_000 });
    const loader = vi.fn()
      .mockResolvedValueOnce(Buffer.from("old"))
      .mockResolvedValueOnce(Buffer.from("new"));
    const first = await cache.getOrLoad("telegram\0bot\0stable", loader);
    const stale = new Date(Date.now() - 5_000);
    await fs.utimes(first.path, stale, stale);
    const partial = path.join(root, "unused.part-crashed");
    await fs.writeFile(partial, "partial");

    const second = await cache.getOrLoad("telegram\0bot\0stable", loader);
    expect(second.bytes.toString()).toBe("new");
    expect(loader).toHaveBeenCalledTimes(2);
    await cache.sweep();
    await expect(fs.access(partial)).rejects.toThrow();
  });

  it("replaces a symlinked hashed entry without touching its external target", async () => {
    const parent = await temporaryRoot();
    const root = path.join(parent, "cache");
    const target = path.join(parent, "outside.txt");
    const identity = "telegram\0bot\0symlinked-entry";
    const symlink = path.join(root, createHash("sha256").update(identity).digest("hex"));
    await fs.mkdir(root);
    await fs.writeFile(target, "outside");
    await fs.symlink(target, symlink);
    const cache = new FileByteCache({ FILE_CACHE_DIR: root, FILE_CACHE_TTL_MS: 3_600_000 });
    const loader = vi.fn(async () => Buffer.from("safe cache bytes"));

    const loaded = await cache.getOrLoad(identity, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loaded.path).toBe(symlink);
    await expect(fs.lstat(symlink)).resolves.toMatchObject({});
    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(symlink, "utf8")).resolves.toBe("safe cache bytes");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("outside");
  });

  it("rejects a symlinked cache root without traversing or chmodding its target", async () => {
    const parent = await temporaryRoot();
    const target = path.join(parent, "outside");
    const root = path.join(parent, "cache");
    const untouched = path.join(target, "untouched.txt");
    await fs.mkdir(target);
    await fs.writeFile(untouched, "outside");
    await fs.symlink(target, root);
    const cache = new FileByteCache({ FILE_CACHE_DIR: root, FILE_CACHE_TTL_MS: 3_600_000 });

    await expect(cache.sweep()).rejects.toThrow("File cache root must be a real directory");
    await expect(fs.readFile(untouched, "utf8")).resolves.toBe("outside");
    expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
  });

  it("honors cancellation before starting a remote fetch", async () => {
    const root = await temporaryRoot();
    const cache = new FileByteCache({ FILE_CACHE_DIR: root, FILE_CACHE_TTL_MS: 3_600_000 });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const loader = vi.fn(async () => Buffer.from("never"));

    await expect(cache.getOrLoad("telegram\0bot\0cancelled", loader, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("lets one waiter cancel without aborting a shared fetch needed by another", async () => {
    const root = await temporaryRoot();
    const cache = new FileByteCache({ FILE_CACHE_DIR: root, FILE_CACHE_TTL_MS: 3_600_000 });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const loader = vi.fn(async (signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        ready.then(resolve, reject);
      });
      return Buffer.from("shared result");
    });
    const controller = new AbortController();
    const cancelled = cache.getOrLoad("matrix\0primary\0shared", loader, controller.signal);
    const survivor = cache.getOrLoad("matrix\0primary\0shared", loader);

    controller.abort(new DOMException("caller cancelled", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    release();

    await expect(survivor).resolves.toMatchObject({ bytes: Buffer.from("shared result") });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]?.[0]?.aborted).toBe(false);
  });

  async function temporaryRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-cache-test-"));
    roots.push(root);
    return root;
  }
});
