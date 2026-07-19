import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { afterEach, describe, expect, it } from "vitest";
import type { BotContext } from "../../src/bot/context.js";
import { installBot } from "../../src/bot/router.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { FileByteCache } from "../../src/files/cache.js";
import { FileResolver } from "../../src/files/resolver.js";
import type { ChatFileSourceAdapter } from "../../src/files/source.js";
import { ManagedFileStore } from "../../src/files/storage.js";
import { TELEGRAM_CONNECTION_KEY } from "../../src/files/telegramSource.js";
import { createLogger } from "../../src/logger.js";
import type { PiRuntimeService } from "../../src/pi/runtime.js";

describe("bot router file adapters", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("preserves an injected resolver's Telegram adapter", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-router-"));
    const config = loadTestConfig({
      FILE_CACHE_DIR: path.join(tempDir, "cache"),
      BASH_WORKSPACE_ROOT: path.join(tempDir, "bash"),
    });
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const resolver = new FileResolver(repos.files, new FileByteCache(config), new ManagedFileStore(config));
    const custom: ChatFileSourceAdapter = {
      transport: "telegram",
      connectionKey: TELEGRAM_CONNECTION_KEY,
      fetch: async () => Buffer.from("custom Telegram adapter"),
    };
    resolver.registry.register(custom);
    const bot = new Bot<BotContext>(config.BOT_TOKEN);
    const pi: PiRuntimeService = {
      runtime: async () => { throw new Error("not used"); },
      compact: async () => 0,
      fork: async () => undefined,
      captionImage: async () => "not used",
      abort: async () => false,
      dispose: async () => undefined,
    };

    installBot(bot, {
      config,
      db,
      logger,
      repos,
      pi,
      fileResolver: resolver,
      downloadFile: async () => { throw new Error("default adapter should not be installed"); },
    });

    expect(resolver.registry.get({ transport: "telegram", connectionKey: TELEGRAM_CONNECTION_KEY })).toBe(custom);
  });
});
