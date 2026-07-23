import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { migrateSandboxData } from "../src/sandbox/migrateData.js";

const apply = process.argv.includes("--apply");
const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase(config, logger);
let failure: unknown;

try {
  const result = await migrateSandboxData({ config, db, apply, logger });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!apply) process.stdout.write("Dry run only. Re-run with --apply after reviewing conflicts and unsafe entries.\n");
  if (result.conflicts || result.unsafeEntries) process.exitCode = 2;
} catch (error) {
  failure = error;
} finally {
  try {
    await db.destroy();
  } catch (cleanupError) {
    if (failure !== undefined) {
      failure = new AggregateError([failure, cleanupError], "Sandbox data migration and database cleanup both failed");
    } else {
      failure = cleanupError;
    }
  }
}

if (failure !== undefined) throw failure;
