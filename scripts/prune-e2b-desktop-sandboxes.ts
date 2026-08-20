import "dotenv/config";
import { Sandbox, type SandboxInfo } from "e2b";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";
import {
  pruneLegacyDesktopSandboxes,
  type DesktopSandboxAdminClient,
  type PrunableSandboxInfo,
} from "../src/e2b/pruneDesktopSandboxes.js";
import { createLogger } from "../src/logger.js";

const execute = process.argv.slice(2).includes("--execute");
const config = loadConfig();
const logger = createLogger(config);
const database = createDatabase(config, logger);

try {
  await database.initialize();
  const repos = createRepos(database.db, database.search);
  const result = await pruneLegacyDesktopSandboxes({
    execute,
    client: createAdminClient(config.E2B_API_KEY, config.E2B_REQUEST_TIMEOUT_MS),
    mappings: repos.threadSandboxes,
    concurrency: 4,
  });
  process.stdout.write(`${JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    matched: result.matched.map(describeSandbox),
    deleted: result.deleted,
    skipped: result.skipped,
    failed: result.failed,
    remaining: result.remaining.map(describeSandbox),
  }, null, 2)}\n`);
  if (!execute) {
    process.stdout.write("Dry run only. Re-run with --execute to delete the matched sandboxes.\n");
  }
  if (execute && (result.failed.length || result.remaining.length)) process.exitCode = 1;
} finally {
  await database.destroy();
}

function createAdminClient(apiKey: string, requestTimeoutMs: number): DesktopSandboxAdminClient {
  return {
    async list() {
      const paginator = Sandbox.list({
        apiKey,
        requestTimeoutMs,
        query: { state: ["running", "paused"] },
      });
      const sandboxes: PrunableSandboxInfo[] = [];
      do {
        const items = await paginator.nextItems({ apiKey, requestTimeoutMs });
        sandboxes.push(...items.map(toPrunable));
      } while (paginator.hasNext);
      return sandboxes;
    },
    async getInfo(sandboxId) {
      return toPrunable(await Sandbox.getInfo(sandboxId, { apiKey, requestTimeoutMs }));
    },
    async kill(sandboxId) {
      await Sandbox.kill(sandboxId, { apiKey, requestTimeoutMs });
    },
  };
}

function toPrunable(info: SandboxInfo): PrunableSandboxInfo {
  return {
    sandboxId: info.sandboxId,
    name: info.name,
    state: info.state,
    metadata: info.metadata,
  };
}

function describeSandbox(info: PrunableSandboxInfo) {
  return {
    sandboxId: info.sandboxId,
    deployment: info.metadata.deployment ?? null,
    state: info.state,
    template: info.name ?? null,
  };
}
