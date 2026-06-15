import { loadConfig } from "./config.js";
import { run } from "@grammyjs/runner";
import { createLogger } from "./logger.js";
import { createDatabase } from "./db/index.js";
import { localizedCommands } from "./bot/commands.js";
import { createBot } from "./bot/router.js";
import { createOpenRouterConversationSummarizer, createOpenRouterImageCaptioner } from "./ai/provider.js";
import { checkDocling } from "./files/docling.js";
import { createOpenRouterTextEmbedder } from "./memory/embeddings.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase(config, logger);

try {
  await db.migrate();
  if (!(await checkDocling(config))) {
    logger.warn("docling healthcheck failed; pdf/docx ingestion will show the docling-down hint", {
      url: config.DOCLING_URL,
    });
  }
  const bot = createBot({
    config,
    db,
    logger,
    embedder: createOpenRouterTextEmbedder(config),
    imageCaptioner: createOpenRouterImageCaptioner(config, logger),
    summarizer: createOpenRouterConversationSummarizer(config, logger),
  });
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
  await db.destroy().catch(() => undefined);
}
