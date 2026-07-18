import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { FileByteCache } from "../../src/files/cache.js";
import { FileResolver } from "../../src/files/resolver.js";
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
    );
    resolver.registry.register(adapter);

    const first = await resolver.resolveFile(file);
    const second = await resolver.resolveFile(file);

    expect(first.bytes.toString()).toBe("remote content");
    expect(first.mimeType).toBe("text/plain");
    expect(second.path).toBe(first.path);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.path).not.toContain("opaque-media-id");
  });
});
