import "dotenv/config";
import { z } from "zod";

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

export const PiThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const OptionalUrlSchema = z.preprocess(normalizeOptionalUrl, z.url().optional());
const OptionalStringSchema = z.preprocess(normalizeOptionalString, z.string().min(1).optional());
const CamofoxUrlSchema = z.preprocess(
  normalizeOptionalUrl,
  z.url().optional().superRefine(validateCamofoxUrl),
);

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
  WEB_EXTRACT_PROVIDER: z.enum(["tavily", "camofox"]).default("tavily"),
  CAMOFOX_URL: CamofoxUrlSchema,
  CAMOFOX_ACCESS_KEY: OptionalStringSchema,
  CAMOFOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CAMOFOX_DEPLOYMENT_ID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("ai-tg-bot"),
  DOCLING_URL: OptionalUrlSchema,
  DOCLING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  E2B_API_KEY: z.string().min(1),
  E2B_TEMPLATE: z.string().min(1).default("ai-tg-bot-tools:production"),
  E2B_DEPLOYMENT_ID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("ai-tg-bot"),
  E2B_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TELEGRAM_FILE_RESTORE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  TELEGRAM_FILE_RESTORE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
  ONBOARDING_TIMEZONE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine(validateCamofoxConfig);

function normalizeOptionalUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeOptionalString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function validateCamofoxUrl(value: string | undefined, context: z.RefinementCtx): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "must use http or https" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "must not contain embedded credentials" });
  }
  if (url.search || url.hash) {
    context.addIssue({ code: "custom", message: "must not contain a query or fragment" });
  }
  if (url.pathname !== "/") {
    context.addIssue({ code: "custom", message: "must contain only the server origin" });
  }
}

function validateCamofoxConfig(value: {
  WEB_EXTRACT_PROVIDER: "tavily" | "camofox";
  CAMOFOX_URL?: string;
  CAMOFOX_ACCESS_KEY?: string;
}, context: z.RefinementCtx): void {
  if (Boolean(value.CAMOFOX_URL) !== Boolean(value.CAMOFOX_ACCESS_KEY)) {
    context.addIssue({
      code: "custom",
      message: "CAMOFOX_URL and CAMOFOX_ACCESS_KEY must be configured together",
      path: [value.CAMOFOX_URL ? "CAMOFOX_ACCESS_KEY" : "CAMOFOX_URL"],
    });
  }
  if (value.WEB_EXTRACT_PROVIDER === "camofox" && (!value.CAMOFOX_URL || !value.CAMOFOX_ACCESS_KEY)) {
    context.addIssue({
      code: "custom",
      message: "WEB_EXTRACT_PROVIDER=camofox requires CAMOFOX_URL and CAMOFOX_ACCESS_KEY",
      path: ["WEB_EXTRACT_PROVIDER"],
    });
  }
}

export type AppConfig = z.infer<typeof ConfigSchema>;

export function isCamofoxConfigured(
  config: Pick<AppConfig, "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY">,
): config is Pick<AppConfig, "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY"> & {
  CAMOFOX_URL: string;
  CAMOFOX_ACCESS_KEY: string;
} {
  return Boolean(config.CAMOFOX_URL && config.CAMOFOX_ACCESS_KEY);
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
