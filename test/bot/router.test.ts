import { Api, Bot, GrammyError, HttpError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { telegramRetry } from "../../src/telegram/retry.js";

describe("Telegram retry safety", () => {
  it.each(["transport", "server"])("does not repeat sends or topic creation after an ambiguous %s failure", async (failure) => {
    for (const method of ["sendDocument", "copyMessage", "forwardMessages", "createForumTopic"] as const) {
      const transport = vi.fn(async () => {
        if (transport.mock.calls.length > 1) return Response.json({ ok: true, result: true });
        if (failure === "transport") throw new Error("Upload accepted but acknowledgment lost");
        return Response.json({ ok: false, error_code: 502, description: "Gateway failed after upload" });
      });
      const api = new Api(loadTestConfig().BOT_TOKEN, { fetch: transport as unknown as typeof fetch });
      api.config.use(telegramRetry());
      await expect(api.raw[method]({} as never)).rejects.toBeInstanceOf(failure === "transport" ? HttpError : GrammyError);
      expect(transport).toHaveBeenCalledOnce();
    }
  });

  it("retries flood-rejected sends and transient failures for reads, edits, and drafts", async () => {
    vi.useFakeTimers();
    try {
      for (const method of ["sendDocument", "getFile", "editMessageText", "sendRichMessageDraft"] as const) {
        const transport = vi.fn(async () => Response.json(transport.mock.calls.length > 1
          ? { ok: true, result: true }
          : method === "sendDocument"
            ? { ok: false, error_code: 429, description: "Flood limit", parameters: { retry_after: 1 } }
            : { ok: false, error_code: 502, description: "Temporary failure" }));
        const api = new Api(loadTestConfig().BOT_TOKEN, { fetch: transport as unknown as typeof fetch });
        api.config.use(telegramRetry());
        const response = api.raw[method]({} as never);
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(response).resolves.toBe(true);
        expect(transport).toHaveBeenCalledTimes(2);
      }
    } finally { vi.useRealTimers(); }
  });
});

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
