import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedFileStore } from "../../src/files/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ManagedFileStore", () => {
  it("atomically preserves the first writeNew result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-file-store-"));
    roots.push(root);
    const store = new ManagedFileStore({ BASH_WORKSPACE_ROOT: root });

    const results = await Promise.allSettled([
      store.writeNew(1, Buffer.from("first")),
      store.writeNew(1, Buffer.from("second")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "EEXIST" } },
    ]);
    expect(["first", "second"]).toContain(await fs.readFile(store.pathFor(1), "utf8"));
    expect((await fs.stat(store.pathFor(1))).mode & 0o777).toBe(0o600);
    await expect(fs.readdir(path.dirname(store.pathFor(1)))).resolves.toEqual(["content"]);
  });
});
