import "dotenv/config";
import { z } from "zod";

const PiThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const OptionalStringSchema = z.preprocess(normalizeOptionalString, z.string().min(1).optional());

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DB_URL: z.string().default("sqlite:./data/bot.db"),
  PI_CODING_AGENT_DIR: z.string().min(1).default("./data/pi"),
  CODEX_AUTH_FILE: OptionalStringSchema,
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().positive().default(128_000),
  PI_THINKING_LEVEL: PiThinkingLevelSchema.default("medium"),
  PI_TURN_TIMEOUT_MS: z.coerce.number().int().min(0).default(900_000),
  PI_MAX_MODEL_CYCLES: z.coerce.number().int().positive().default(20),
  PI_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(40),
  PI_MAX_CONSECUTIVE_TOOL_FAILURES: z.coerce.number().int().positive().default(5),
  PI_MAX_IDENTICAL_TOOL_FAILURES: z.coerce.number().int().positive().default(3),
  THREAD_TITLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  CODEX_MODEL: z.string().default("gpt-5.6-sol"),
  CODEX_HELPER_MODEL: z.string().default("gpt-5.6-luna"),
  OPENROUTER_MAIN_MODEL: z.string().default("openai/gpt-5.6-sol"),
  OPENROUTER_HELPER_MODEL: z.string().default("openai/gpt-5.6-luna"),
  OPENROUTER_IMAGE_MODEL: z.string().default("openai/gpt-5.4-image-2"),
  IMAGE_TIMEOUT_MS: z.coerce.number().int().min(0).default(300_000),
  OPENROUTER_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().min(1),
  BROWSER_USE_API_KEY: OptionalStringSchema,
  BROWSER_USE_DEPLOYMENT_ID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("ai-tg-bot"),
  BROWSER_USE_DEFAULT_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(240).default(5),
  BROWSER_USE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  BROWSER_USE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BROWSER_USE_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  E2B_API_KEY: z.string().min(1),
  E2B_TEMPLATE: z.string().min(1).default("ai-tg-bot-tools:production"),
  E2B_DEPLOYMENT_ID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("ai-tg-bot"),
  E2B_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  E2B_FILE_SOURCE_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  TELEGRAM_FILE_RESTORE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  TELEGRAM_FILE_RESTORE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
  ONBOARDING_TIMEZONE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function normalizeOptionalString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

export type AppConfig = z.infer<typeof ConfigSchema>;

export function isBrowserUseConfigured(
  config: Pick<AppConfig, "BROWSER_USE_API_KEY">,
): config is Pick<AppConfig, "BROWSER_USE_API_KEY"> & {
  BROWSER_USE_API_KEY: string;
} {
  return Boolean(config.BROWSER_USE_API_KEY);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}

export function loadTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = ConfigSchema.parse({
    BOT_TOKEN: "TEST:TOKEN",
    OPENROUTER_API_KEY: "test-openrouter",
    TAVILY_API_KEY: "test-tavily",
    E2B_API_KEY: "test-e2b",
  });
  return {
    ...base,
    DB_URL: "sqlite::memory:",
    DRAFT_UPDATE_MS: 0,
    ONBOARDING_TIMEZONE_DELAY_MS: 0,
    LOG_LEVEL: "error",
    ...overrides,
  };
}
