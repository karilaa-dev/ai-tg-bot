import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";

const BOXLITE_ENV_KEYS = [
  "BOXLITE_AGENT_IMAGE",
  "BOXLITE_GUEST_USER",
  "BOXLITE_BOX_NAME_PREFIX",
  "BOXLITE_MEMORY_MIB",
  "BOXLITE_CPUS",
  "BOXLITE_DISK_SIZE_GB",
  "BOXLITE_PROVISION_TIMEOUT_MS",
  "BOXLITE_REQUEST_TIMEOUT_MS",
] as const;

export async function createLiveBoxliteConfig(
  label: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ config: AppConfig; tempRoot: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ai-tg-bot-${label}-`));
  const boxliteEnv: NodeJS.ProcessEnv = {};
  for (const key of BOXLITE_ENV_KEYS) {
    if (process.env[key] !== undefined) boxliteEnv[key] = process.env[key];
  }

  const agentSharedRoot = path.join(tempRoot, "agent-shared");
  const config = loadConfig({
    BOT_TOKEN: "live-check:not-used",
    OPENROUTER_API_KEY: "live-check-not-used",
    TAVILY_API_KEY: "live-check-not-used",
    DB_URL: "sqlite::memory:",
    DOCLING_URL: "",
    BASH_WORKSPACE_ROOT: path.join(tempRoot, "legacy-bash"),
    AGENT_SHARED_ROOT: agentSharedRoot,
    MANAGED_FILE_ROOT: path.join(agentSharedRoot, ".chat-files"),
    BOXLITE_HOME: path.join(tempRoot, "boxlite-home"),
    PI_CODING_AGENT_DIR: path.join(tempRoot, "pi"),
    LOG_LEVEL: "info",
    ...boxliteEnv,
    ...overrides,
  });
  return { config, tempRoot };
}
