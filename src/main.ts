import { run } from "@grammyjs/runner";
import { localizedCommands } from "./bot/commands.js";
import { createBot } from "./bot/router.js";
import { isBrowserUseConfigured, loadConfig, type AppConfig } from "./config.js";
import { createBrowserUseClient } from "./browserUse/client.js";
import { createDatabase } from "./db/index.js";
import { createRepos } from "./db/repos/index.js";
import { checkDocling } from "./files/docling.js";
import { createLogger, type Logger } from "./logger.js";
import { createOpenRouterTextEmbedder } from "./memory/embeddings.js";
import { PiRuntimeManager } from "./pi/runtime.js";
import { ThreadE2BSandboxRuntimeManager } from "./e2b/threadRuntimeManager.js";
import { verifyUpgradeBaselineOnce } from "./upgrade/audit.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase(config, logger);
let pi: PiRuntimeManager | undefined;
let sandboxRuntime: ThreadE2BSandboxRuntimeManager | undefined;
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
  logger.debug("initializing database");
  await db.initialize();
  await verifyUpgradeBaselineOnce({
    db: db.db,
    piCodingAgentDir: config.PI_CODING_AGENT_DIR,
    baselineFile: config.UPGRADE_BASELINE_FILE,
    logger,
  });
  await checkConfiguredDocling(config, logger);
  await checkConfiguredBrowserUse(config, logger);
  const repos = createRepos(db.db, db.search);
  const embedder = createOpenRouterTextEmbedder(config, logger);
  sandboxRuntime = new ThreadE2BSandboxRuntimeManager({
    config,
    repos,
    logger,
  });
  pi = new PiRuntimeManager({ config, db, repos, logger, embedder, commandRuntime: sandboxRuntime });
  await pi.initialize();
  const bot = createBot({
    config,
    db,
    logger,
    repos,
    embedder,
    commandRuntime: sandboxRuntime,
    pi,
  });
  logger.debug("registering bot commands");
  await bot.api.setMyCommands(localizedCommands("en"));
  await bot.api.setMyCommands(localizedCommands("ru"), { scope: { type: "all_private_chats" }, language_code: "ru" });
  logger.info("database initialized, runner polling started");
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
    logger.warn("E2B runtime disposal failed", { err: String(err) });
  });
  logger.debug("destroying database connection");
  await db.destroy().catch((err) => logger.warn("database destroy failed", { err: String(err) }));
}

async function checkConfiguredBrowserUse(
  config: Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_API_TIMEOUT_MS">,
  logger: Logger,
): Promise<void> {
  if (!isBrowserUseConfigured(config)) {
    logger.info("Browser Use Cloud disabled; interactive browser and Office visual previews are unavailable");
    return;
  }
  logger.debug("checking Browser Use Cloud authentication");
  try {
    const active = await createBrowserUseClient(config).listActiveBrowsers();
    logger.info("Browser Use Cloud authentication passed", { activeBrowsers: active.totalItems });
  } catch (err) {
    logger.warn("Browser Use Cloud authentication failed; browser-backed tools may be unavailable", {
      err: String(err),
    });
  }
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
