import { run } from "@grammyjs/runner";
import { localizedCommands } from "./bot/commands.js";
import { createBot } from "./bot/router.js";
import { createOpenSandboxClientProvider } from "./opensandbox/client.js";
import { UserOpenSandboxRuntimeManager } from "./opensandbox/userRuntimeManager.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { createRepos } from "./db/repos/index.js";
import { checkDocling } from "./files/docling.js";
import { clearManagedFiles } from "./files/storage.js";
import { createLogger, type Logger } from "./logger.js";
import { createOpenRouterTextEmbedder } from "./memory/embeddings.js";
import { legacyCodexAuthCandidates, migrateLegacyCodexAuth } from "./pi/authMigration.js";
import { PiRuntimeManager } from "./pi/runtime.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase(config, logger);
let pi: PiRuntimeManager | undefined;
let sandboxRuntime: UserOpenSandboxRuntimeManager | undefined;
logger.info("bot process starting", {
  logLevel: logger.level,
  db: db.dialect,
  inferenceProvider: "pi",
  model: config.CODEX_MODEL,
  fallbackModel: config.OPENROUTER_MAIN_MODEL,
});

try {
  if (process.getuid?.() === 0) {
    throw new Error("The bot process must run as a non-root user.");
  }
  logger.debug("running database migrations");
  const migration = await db.migrate();
  if (migration.piCutoverApplied) {
    const deletedFiles = await clearManagedFiles();
    logger.info("Pi cutover cleanup complete", { deletedRows: migration.deletedRows, deletedFiles, preserved: config.BASH_WORKSPACE_ROOT });
  }
  if (migration.fileSourcesApplied) {
    logger.info("chat file source migration complete", { migratedSources: migration.migratedFileSources });
  }
  if (migration.inviteRemovalApplied) {
    logger.info("built-in invite access schema removed");
  }
  if (migration.messageEmbeddingCleanupApplied) {
    logger.info("obsolete message embeddings removed", {
      deleted: migration.deletedMessageEmbeddings,
    });
  }
  await checkConfiguredDocling(config, logger);
  const repos = createRepos(db.db, db.search);
  const embedder = createOpenRouterTextEmbedder(config, logger);
  await migrateLegacyCodexAuth({
    agentDir: config.PI_CODING_AGENT_DIR,
    logger,
    legacyAuthPaths: legacyCodexAuthCandidates(config.PI_CODING_AGENT_DIR),
  });
  sandboxRuntime = new UserOpenSandboxRuntimeManager({
    config,
    clientProvider: createOpenSandboxClientProvider(config),
    logger,
  });
  pi = new PiRuntimeManager({ config, db, repos, logger, embedder, commandRuntime: sandboxRuntime });
  const bot = createBot({
    config,
    db,
    logger,
    repos,
    embedder,
    pi,
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
  await pi?.dispose().catch((err) => logger.warn("Pi runtime disposal failed", { err: String(err) }));
  await sandboxRuntime?.dispose().catch((err) => {
    process.exitCode = 1;
    logger.warn("OpenSandbox runtime disposal failed", { err: String(err) });
  });
  logger.debug("destroying database connection");
  await db.destroy().catch((err) => logger.warn("database destroy failed", { err: String(err) }));
}

async function checkConfiguredDocling(
  config: Pick<AppConfig, "DOCLING_URL">,
  logger: Logger,
): Promise<void> {
  if (!config.DOCLING_URL) {
    logger.info("docling disabled; DOCX and scanned PDF conversion is unavailable");
    return;
  }

  logger.debug("checking docling health", { url: config.DOCLING_URL });
  try {
    await checkDocling(config);
    logger.info("docling healthcheck passed", { url: config.DOCLING_URL });
  } catch (err) {
    logger.warn("docling healthcheck failed; conversions requiring Docling will be unavailable", {
      url: config.DOCLING_URL,
      err: String(err),
    });
  }
}
