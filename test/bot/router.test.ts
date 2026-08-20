import { Bot } from "grammy";
import { afterEach, describe, expect, it } from "vitest";
import type { BotContext } from "../../src/bot/context.js";
import { installBot } from "../../src/bot/router.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { FileResolver } from "../../src/files/resolver.js";
import type { ChatFileSourceAdapter } from "../../src/files/source.js";
import { TELEGRAM_CONNECTION_KEY } from "../../src/files/telegramSource.js";
import { createLogger } from "../../src/logger.js";
import type { PiRuntimeService } from "../../src/pi/runtime.js";

describe("bot router file adapters", () => {
  let db: AppDatabase | undefined;

  afterEach(async () => {
    await db?.destroy();
  });

  it("preserves an injected resolver's Telegram adapter", async () => {
    const config = loadTestConfig();
    const logger = createLogger(config);
    db = createDatabase(config, logger);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const resolver = new FileResolver(repos.files);
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
      generateThreadTitle: async () => "not used",
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
