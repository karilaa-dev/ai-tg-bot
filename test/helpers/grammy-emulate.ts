import { TestBot } from "@bonkers-agency/grammy-test";
import type { Chat, User } from "grammy/types";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTestConfig, type AppConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { installBot } from "../../src/bot/router.js";
import type { BotContext } from "../../src/bot/context.js";
import { sendFinal, type TurnRunner } from "../../src/ai/run.js";
import type { TelegramFileDownloader } from "../../src/files/telegram.js";
import type { TextEmbedder } from "../../src/memory/embeddings.js";
import type { PiRuntimeService } from "../../src/pi/runtime.js";

export interface GrammyEmulator {
  bot: TestBot<BotContext>;
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  user: User;
  chat: Chat.PrivateChat;
  dispose(): Promise<void>;
}

export async function createGrammyEmulator(options: {
  config?: Partial<AppConfig>;
  turnRunner?: TurnRunner;
  privateTopics?: boolean;
  imageCaptioner?: { caption(input: { bytes: Buffer; name: string; mime?: string }): Promise<string> };
  pi?: PiRuntimeService;
  downloadFile?: TelegramFileDownloader;
  embedder?: TextEmbedder;
} = {}): Promise<GrammyEmulator> {
  const ownsCacheDir = !options.config?.FILE_CACHE_DIR;
  const cacheDir = options.config?.FILE_CACHE_DIR
    ?? await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-test-files-"));
  const ownsBashRoot = !options.config?.BASH_WORKSPACE_ROOT;
  const bashRoot = options.config?.BASH_WORKSPACE_ROOT
    ?? await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-test-bash-"));
  const config = loadTestConfig({
    ...options.config,
    FILE_CACHE_DIR: cacheDir,
    BASH_WORKSPACE_ROOT: bashRoot,
  });
  const logger = createLogger(config);
  const db = createDatabase(config, logger);
  await db.migrate();
  const repos = createRepos(db.db, db.search);
  const bot = new TestBot<BotContext>({
    token: config.BOT_TOKEN,
    botInfo: {
      id: 999,
      is_bot: true,
      first_name: "AITestBot",
      username: "ai_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: options.privateTopics ?? false,
    } as never,
  });
  const turnRunner =
    options.turnRunner ??
    (async (input) => {
      const latest = await input.repos.messages.latest(input.thread.id);
      const message =
        latest?.role === "user" && latest.text_plain === input.text
          ? latest
          : await input.repos.messages.insert({
              threadId: input.thread.id,
              role: "user",
              kind: input.userMessageKind,
              content: input.userMessageContent ?? { text: input.text },
              textPlain: input.text,
            });
      await input.onUserMessagePersisted?.(message);
      await sendFinal(input, "", `Echo: ${input.text}`);
    });
  const pi: PiRuntimeService = options.pi ?? {
    runtime: async () => { throw new Error("Pi runtime is not used by the echo test runner"); },
    compact: async () => 0,
    fork: async () => undefined,
    captionImage: async (bytes, mimeType) => options.imageCaptioner
      ? options.imageCaptioner.caption({ bytes, name: "telegram-image", mime: mimeType })
      : "Telegram image",
    abort: async () => false,
    dispose: async () => undefined,
  };
  installBot(bot as unknown as any, {
    config,
    db,
    logger,
    repos,
    turnRunner,
    pi,
    embedder: options.embedder,
    downloadFile: options.downloadFile ?? (async ({ fileId }) => {
      const content = bot.server.fileState.getFileContent(fileId);
      if (!content) throw new Error(`test file content not found: ${fileId}`);
      return { bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) };
    }),
  });
  const user = bot.createUser({ id: 1001, first_name: "Alice", language_code: "en" });
  const chat = bot.createChat({ id: user.id, type: "private", first_name: "Alice" }) as Chat.PrivateChat;
  if (options.privateTopics) {
    bot.setBotAdmin(chat, { can_manage_topics: true });
    const state = bot.server.chatState.get(chat.id);
    if (state) {
      state.isForum = true;
      state.generalTopicId = 1;
      state.forumTopics.set(1, {
        topic: { message_thread_id: 1, name: "General", icon_color: 0x6fb9f0 },
        isClosed: false,
        isPinned: true,
      });
    }
  }
  return {
    bot,
    config,
    db,
    repos,
    user,
    chat,
    dispose: async () => {
      bot.dispose();
      await db.destroy();
      if (ownsCacheDir) await fs.rm(cacheDir, { recursive: true, force: true });
      if (ownsBashRoot) await fs.rm(bashRoot, { recursive: true, force: true });
    },
  };
}
