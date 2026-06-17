import "dotenv/config";
import { z } from "zod";

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

export const ReasoningSummarySchema = z.enum(["auto", "concise", "detailed", "none"]);
export type ReasoningSummary = z.infer<typeof ReasoningSummarySchema>;
export const CodexVerbositySchema = z.enum(["low", "medium", "high"]);
export type CodexVerbosity = z.infer<typeof CodexVerbositySchema>;
export const CodexImageQualitySchema = z.enum(["low", "medium", "high", "auto"]);
export type CodexImageQuality = z.infer<typeof CodexImageQualitySchema>;
const OptionalUrlSchema = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_ID: z.coerce.number().int(),
  DB_URL: z.string().default("sqlite:./data/bot.db"),
  CODEX_MODEL: z.string().default("gpt-5.5"),
  CODEX_COMPACTION_MODEL: z.string().default("gpt-5.4-mini"),
  CODEX_IMAGE_MODEL: z.string().default("gpt-image-2"),
  CODEX_IMAGE_QUALITY: CodexImageQualitySchema.default("low"),
  CODEX_SPEED_MODE: z.enum(["standard", "fast"]).default("standard"),
  CODEX_VERBOSITY: CodexVerbositySchema.default("high"),
  CODEX_TURN_TIMEOUT_MS: z.coerce.number().int().min(0).default(900_000),
  REASONING_SUMMARY: ReasoningSummarySchema.default("none"),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_EMBEDDING_MODEL: z
    .string()
    .default(DEFAULT_OPENROUTER_EMBEDDING_MODEL),
  TAVILY_API_KEY: z.string().min(1),
  CONTEXT_WARN_RATIO: z.coerce.number().positive().max(1).default(0.85),
  DOCLING_URL: z.string().url().default("http://localhost:5001"),
  DOCLING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  GENERATED_MEDIA_PUBLIC_BASE_URL: OptionalUrlSchema,
  BASH_WORKSPACE_ROOT: z.string().min(1).default("./data/bash"),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
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
    BOT_TOKEN: "TEST:TOKEN",
    TELEGRAM_ADMIN_ID: 1000,
    DB_URL: "sqlite::memory:",
    CODEX_MODEL: "gpt-5.5",
    CODEX_COMPACTION_MODEL: "gpt-5.4-mini",
    CODEX_IMAGE_MODEL: "gpt-image-2",
    CODEX_IMAGE_QUALITY: "low",
    CODEX_SPEED_MODE: "standard",
    CODEX_VERBOSITY: "high",
    CODEX_TURN_TIMEOUT_MS: 900_000,
    REASONING_SUMMARY: "none",
    OPENROUTER_API_KEY: "test-openrouter",
    OPENROUTER_EMBEDDING_MODEL: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
    TAVILY_API_KEY: "test-tavily",
    CONTEXT_WARN_RATIO: 0.85,
    DOCLING_URL: "http://localhost:5001",
    DOCLING_TIMEOUT_MS: 300_000,
    FILE_INLINE_TOKENS: 6000,
    GENERATED_MEDIA_PUBLIC_BASE_URL: undefined,
    BASH_WORKSPACE_ROOT: "./data/bash",
    BASH_TIMEOUT_MS: 30_000,
    BASH_MAX_OUTPUT_CHARS: 12_000,
    DRAFT_UPDATE_MS: 0,
    STREAM_DELTA_CHARS: 48,
    RECENT_WINDOW_MESSAGES: 20,
    LOG_LEVEL: "error",
    ...overrides,
  };
}
