import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createDatabase } from "./index.js";

const config = loadConfig();
const logger = createLogger(config);
const appDb = createDatabase(config, logger);

try {
  await appDb.migrate();
  logger.info("migration complete");
} finally {
  await appDb.destroy();
}
