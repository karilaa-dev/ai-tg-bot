import "dotenv/config";
import { z } from "zod";

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

export const ReasoningSummarySchema = z.enum(["auto", "concise", "detailed", "none"]);
export type ReasoningSummary = z.infer<typeof ReasoningSummarySchema>;
export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export const CodexVerbositySchema = z.enum(["low", "medium", "high"]);
export type CodexVerbosity = z.infer<typeof CodexVerbositySchema>;
export const CodexImageQualitySchema = z.enum(["low", "medium", "high", "auto"]);
export type CodexImageQuality = z.infer<typeof CodexImageQualitySchema>;

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_ID: z.coerce.number().int(),
  DB_URL: z.string().default("sqlite:./data/bot.db"),
  CODEX_MODEL: z.string().default("gpt-5.6-sol"),
  CODEX_COMPACTION_MODEL: z.string().default("gpt-5.4-mini"),
  CODEX_IMAGE_MODEL: z.string().default("gpt-image-2"),
  CODEX_IMAGE_QUALITY: CodexImageQualitySchema.default("low"),
  CODEX_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(0).default(300_000),
  CODEX_SPEED_MODE: z.enum(["standard", "fast"]).default("fast"),
  CODEX_VERBOSITY: CodexVerbositySchema.default("high"),
  CODEX_TURN_TIMEOUT_MS: z.coerce.number().int().min(0).default(900_000),
  REASONING_EFFORT: ReasoningEffortSchema.default("medium"),
  REASONING_SUMMARY: ReasoningSummarySchema.default("detailed"),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_EMBEDDING_MODEL: z
    .string()
    .default(DEFAULT_OPENROUTER_EMBEDDING_MODEL),
  TAVILY_API_KEY: z.string().min(1),
  CONTEXT_WARN_RATIO: z.coerce.number().positive().max(1).default(0.85),
  DOCLING_URL: z.string().url().default("http://localhost:5001"),
  DOCLING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  BASH_WORKSPACE_ROOT: z.string().min(1).default("./data/bash"),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
  ONBOARDING_TIMEZONE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  STREAM_DELTA_CHARS: z.coerce.number().int().positive().default(48),
  RECENT_WINDOW_MESSAGES: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}

export function loadTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...ConfigSchema.parse({
      BOT_TOKEN: "TEST:TOKEN",
      TELEGRAM_ADMIN_ID: "1000",
      OPENROUTER_API_KEY: "test-openrouter",
      TAVILY_API_KEY: "test-tavily",
    }),
    DB_URL: "sqlite::memory:",
    DRAFT_UPDATE_MS: 0,
    ONBOARDING_TIMEZONE_DELAY_MS: 0,
    LOG_LEVEL: "error",
    ...overrides,
  };
}
