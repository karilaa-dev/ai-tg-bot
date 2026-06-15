import "dotenv/config";
import { z } from "zod";

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

const optionalNumber = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? Number(value) : undefined));

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_ID: z.coerce.number().int(),
  DB_URL: z.string().default("sqlite:./data/bot.db"),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default("openai/gpt-5.5"),
  OPENROUTER_COMPACTION_MODEL: z.string().default("openai/gpt-5.4-mini"),
  OPENROUTER_REASONING_EFFORT: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
    .default("low"),
  OPENROUTER_EMBEDDING_MODEL: z
    .string()
    .default(DEFAULT_OPENROUTER_EMBEDDING_MODEL),
  TAVILY_API_KEY: z.string().min(1),
  MODEL_CONTEXT_TOKENS_OVERRIDE: optionalNumber,
  RESERVE_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  CONTEXT_WARN_RATIO: z.coerce.number().positive().max(1).default(0.85),
  DOCLING_URL: z.string().url().default("http://localhost:5001"),
  DOCLING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  SHOW_MORE_THRESHOLD_CHARS: z.coerce.number().int().positive().default(3500),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
  RECENT_WINDOW_MESSAGES: z.coerce.number().int().positive().default(20),
  MAX_TOOL_STEPS: z.coerce.number().int().positive().default(8),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}

export function loadTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    BOT_TOKEN: "TEST:TOKEN",
    TELEGRAM_ADMIN_ID: 1000,
    DB_URL: "sqlite::memory:",
    OPENROUTER_API_KEY: "test-openrouter",
    OPENROUTER_MODEL: "openai/gpt-5.5",
    OPENROUTER_COMPACTION_MODEL: "openai/gpt-5.4-mini",
    OPENROUTER_REASONING_EFFORT: "low",
    OPENROUTER_EMBEDDING_MODEL: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
    TAVILY_API_KEY: "test-tavily",
    MODEL_CONTEXT_TOKENS_OVERRIDE: 128000,
    RESERVE_OUTPUT_TOKENS: 8000,
    CONTEXT_WARN_RATIO: 0.85,
    DOCLING_URL: "http://localhost:5001",
    DOCLING_TIMEOUT_MS: 300_000,
    FILE_INLINE_TOKENS: 6000,
    SHOW_MORE_THRESHOLD_CHARS: 3500,
    DRAFT_UPDATE_MS: 0,
    RECENT_WINDOW_MESSAGES: 20,
    MAX_TOOL_STEPS: 8,
    LOG_LEVEL: "error",
    ...overrides,
  };
}
