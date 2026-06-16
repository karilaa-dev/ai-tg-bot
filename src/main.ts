import { loadConfig } from "./config.js";
import { run } from "@grammyjs/runner";
import { createLogger } from "./logger.js";
import { createDatabase } from "./db/index.js";
import { localizedCommands } from "./bot/commands.js";
import { createBot } from "./bot/router.js";
import { createConversationSummarizer, createImageCaptioner } from "./ai/inference.js";
import { checkDocling } from "./files/docling.js";
import { createOpenRouterTextEmbedder } from "./memory/embeddings.js";

const config = loadConfig();
const logger = createLogger(config);
logger.info("bot process starting", {
  logLevel: logger.level,
  db: config.DB_URL.startsWith("postgres") ? "postgres" : "sqlite",
  inferenceProvider: "codex",
  model: config.CODEX_MODEL,
  compactionModel: config.CODEX_COMPACTION_MODEL,
});
const db = createDatabase(config, logger);

try {
  logger.debug("running database migrations");
  await db.migrate();
  logger.debug("checking docling health", { url: config.DOCLING_URL });
  if (!(await checkDocling(config))) {
    logger.warn("docling healthcheck failed; pdf/docx ingestion will show the docling-down hint", {
      url: config.DOCLING_URL,
    });
  } else {
    logger.info("docling healthcheck passed", { url: config.DOCLING_URL });
  }
  const bot = createBot({
    config,
    db,
    logger,
    embedder: createOpenRouterTextEmbedder(config, logger),
    imageCaptioner: createImageCaptioner(config, logger),
    summarizer: createConversationSummarizer(config, logger),
  });
  logger.debug("registering bot commands");
  await bot.api.setMyCommands(localizedCommands("en"));
  await bot.api.setMyCommands(localizedCommands("ru"), { scope: { type: "all_private_chats" }, language_code: "ru" });
  logger.info("migrated, runner polling started");
  await bot.init();
  const handle = run(bot);
  logger.info("bot started", { username: bot.botInfo.username });
  const stop = async () => {
    if (!handle.isRunning()) return;
    logger.info("bot stopping");
    await handle.stop();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await handle.task();
} catch (err) {
  logger.error("bot stopped", { err: String(err) });
  process.exitCode = 1;
} finally {
  logger.debug("destroying database connection");
  await db.destroy().catch((err) => logger.warn("database destroy failed", { err: String(err) }));
}
