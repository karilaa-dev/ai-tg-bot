import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

export const PiThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_BOXLITE_GUEST_USER = "agent";
const MAX_LINUX_ID = 4_294_967_294;
const GUEST_USER_FORMAT_MESSAGE = "must be a Linux username, numeric UID, or numeric UID:GID";
const LinuxUsernameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/, GUEST_USER_FORMAT_MESSAGE);
const NumericGuestUserSchema = z.string().superRefine(validateNumericGuestUser);
const BoxLiteGuestUserSchema = z.union([LinuxUsernameSchema, NumericGuestUserSchema]);
const OptionalUrlSchema = z.preprocess(normalizeOptionalUrl, z.string().trim().url().optional());

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DB_URL: z.string().default("sqlite:./data/bot.db"),
  PI_CODING_AGENT_DIR: z.string().min(1).default("./data/pi"),
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().positive().default(128_000),
  PI_THINKING_LEVEL: PiThinkingLevelSchema.default("medium"),
  PI_TURN_TIMEOUT_MS: z.coerce.number().int().min(0).default(900_000),
  THREAD_TITLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  CODEX_MODEL: z.string().default("gpt-5.6-sol"),
  CODEX_HELPER_MODEL: z.string().default("gpt-5.6-luna"),
  OPENROUTER_MAIN_MODEL: z.string().default("openai/gpt-5.6-sol"),
  OPENROUTER_HELPER_MODEL: z.string().default("openai/gpt-5.6-luna"),
  OPENROUTER_IMAGE_MODEL: z.string().default("openai/gpt-5.4-image-2"),
  IMAGE_TIMEOUT_MS: z.coerce.number().int().min(0).default(300_000),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_EMBEDDING_MODEL: z
    .string()
    .default(DEFAULT_OPENROUTER_EMBEDDING_MODEL),
  TAVILY_API_KEY: z.string().min(1),
  DOCLING_URL: OptionalUrlSchema,
  DOCLING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  FILE_CACHE_DIR: z.string().min(1).default(path.join(os.tmpdir(), "ai-tg-bot-files")),
  FILE_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  BASH_WORKSPACE_ROOT: z.string().min(1).default("./data/bash"),
  AGENT_SHARED_ROOT: z.string().min(1).default("./data/agent"),
  MANAGED_FILE_ROOT: z.string().min(1).default("./data/agent/.chat-files"),
  BOXLITE_HOME: z.string().min(1).default("./data/boxlite"),
  BOXLITE_AGENT_IMAGE: z.string().min(1).default("ghcr.io/karilaa-dev/ai-agent-box:latest"),
  BOXLITE_GUEST_USER: BoxLiteGuestUserSchema.default(DEFAULT_BOXLITE_GUEST_USER),
  BOXLITE_BOX_NAME_PREFIX: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("ai-tg-bot"),
  BOXLITE_MEMORY_MIB: z.coerce.number().int().min(128).default(512),
  BOXLITE_CPUS: z.coerce.number().int().positive().default(2),
  BOXLITE_DISK_SIZE_GB: z.coerce.number().int().positive().default(10),
  BOXLITE_IDLE_STOP_MS: z.coerce.number().int().positive().default(600_000),
  BOXLITE_PROVISION_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  BOXLITE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
  ONBOARDING_TIMEZONE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine(validateStorageIsolation);

function validateNumericGuestUser(value: string, context: z.RefinementCtx): void {
  if (!/^(?:0|[1-9]\d*)(?::(?:0|[1-9]\d*))?$/.test(value)) {
    context.addIssue({ code: "custom", message: GUEST_USER_FORMAT_MESSAGE });
    return;
  }

  for (const id of value.split(":")) {
    if (Number(id) > MAX_LINUX_ID) {
      context.addIssue({ code: "custom", message: `UID and GID must not exceed ${MAX_LINUX_ID}` });
      return;
    }
  }
}

function normalizeOptionalUrl(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function validateStorageIsolation(
  config: { AGENT_SHARED_ROOT: string; MANAGED_FILE_ROOT: string; BOXLITE_HOME: string },
  context: z.RefinementCtx,
): void {
  const sharedRoot = path.resolve(config.AGENT_SHARED_ROOT);
  const managedRoot = path.resolve(config.MANAGED_FILE_ROOT);
  const boxliteHome = path.resolve(config.BOXLITE_HOME);

  if (pathContains(path.join(sharedRoot, "users"), managedRoot)) {
    context.addIssue({
      code: "custom",
      path: ["MANAGED_FILE_ROOT"],
      message: "must be outside AGENT_SHARED_ROOT/users so canonical chat files are never mounted into a user VM",
    });
  }
  if (pathsOverlap(sharedRoot, boxliteHome)) {
    context.addIssue({
      code: "custom",
      path: ["BOXLITE_HOME"],
      message: "must not overlap AGENT_SHARED_ROOT because BoxLite runtime state must never be mounted into a user VM",
    });
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function pathsOverlap(first: string, second: string): boolean {
  return pathContains(first, second) || pathContains(second, first);
}

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}

export function loadTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = ConfigSchema.parse({
    BOT_TOKEN: "TEST:TOKEN",
    OPENROUTER_API_KEY: "test-openrouter",
    TAVILY_API_KEY: "test-tavily",
  });
  const legacyRoot = overrides.BASH_WORKSPACE_ROOT ?? base.BASH_WORKSPACE_ROOT;
  return {
    ...base,
    DB_URL: "sqlite::memory:",
    AGENT_SHARED_ROOT: path.join(legacyRoot, ".boxlite"),
    MANAGED_FILE_ROOT: path.join(legacyRoot, ".chat-files"),
    DRAFT_UPDATE_MS: 0,
    ONBOARDING_TIMEZONE_DELAY_MS: 0,
    LOG_LEVEL: "error",
    ...overrides,
  };
}
