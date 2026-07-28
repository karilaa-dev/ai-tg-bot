import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isPathWithin } from "./util/paths.js";

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";

export const PiThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const MAX_LINUX_ID = 4_294_967_294;
const OptionalUrlSchema = z.preprocess(normalizeOptionalUrl, z.url().optional());
const OptionalStringSchema = z.preprocess(normalizeOptionalString, z.string().min(1).optional());
const BrowserlessUrlSchema = z.preprocess(
  normalizeOptionalUrl,
  z.string().optional().superRefine(validateBrowserlessUrl),
);
const BooleanEnvSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());
const AbsoluteHostPathSchema = z.string().min(1).superRefine((value, context) => {
  if (!path.isAbsolute(value)) context.addIssue({ code: "custom", message: "must be an absolute host path" });
  if (path.parse(path.resolve(value)).root === path.resolve(value)) {
    context.addIssue({ code: "custom", message: "must not be the filesystem root" });
  }
});

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
  BROWSERLESS_URL: BrowserlessUrlSchema,
  BROWSERLESS_TOKEN: OptionalStringSchema,
  BROWSERLESS_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  FILE_INLINE_TOKENS: z.coerce.number().int().positive().default(6000),
  FILE_CACHE_DIR: z.string().min(1).default(path.join(os.tmpdir(), "ai-tg-bot-files")),
  FILE_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  AGENT_SHARED_ROOT: z.string().min(1).default("./data/agent"),
  MANAGED_FILE_ROOT: z.string().min(1).default("./data/agent/.chat-files"),
  OPEN_SANDBOX_DOMAIN: z.string().min(1).default("localhost:8080"),
  OPEN_SANDBOX_PROTOCOL: z.enum(["http", "https"]).default("http"),
  OPEN_SANDBOX_API_KEY: z.string().min(1),
  OPEN_SANDBOX_USE_SERVER_PROXY: BooleanEnvSchema.default(true),
  OPEN_SANDBOX_SHARED_HOST_ROOT: AbsoluteHostPathSchema.default(path.resolve("./data/agent")),
  OPEN_SANDBOX_DEPLOYMENT_ID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("ai-tg-bot"),
  OPEN_SANDBOX_IMAGE: z.string().min(1).default("ghcr.io/karilaa-dev/ai-agent-box:latest"),
  OPEN_SANDBOX_CPU: z.string().regex(/^\d+(?:\.\d+)?$/).default("2"),
  OPEN_SANDBOX_MEMORY: z.string().regex(/^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti)$/).default("512Mi"),
  OPEN_SANDBOX_USER: z.string().trim().min(1).default("agent"),
  OPEN_SANDBOX_GROUP: z.string().trim().min(1).default("agent"),
  OPEN_SANDBOX_UID: z.coerce.number().int().min(1).max(MAX_LINUX_ID).default(1000),
  OPEN_SANDBOX_GID: z.coerce.number().int().min(1).max(MAX_LINUX_ID).default(1000),
  OPEN_SANDBOX_IDLE_PAUSE_MS: z.coerce.number().int().positive().default(300_000),
  OPEN_SANDBOX_IDLE_RELEASE_MS: z.coerce.number().int().positive().default(900_000),
  OPEN_SANDBOX_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  OPEN_SANDBOX_CONTROL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OPEN_SANDBOX_INTERRUPT_GRACE_MS: z.coerce.number().int().positive().default(5_000),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BASH_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  DRAFT_UPDATE_MS: z.coerce.number().int().min(0).default(0),
  ONBOARDING_TIMEZONE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
})
  .superRefine(validateStorageIsolation)
  .superRefine(validateSandboxIdlePolicy)
  .superRefine(validateBrowserlessToken);

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

function validateBrowserlessUrl(value: string | undefined, context: z.RefinementCtx): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid URL" });
    return;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    context.addIssue({ code: "custom", message: "must use http, https, ws, or wss" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "must not contain embedded credentials" });
  }
  if (url.hash) {
    context.addIssue({ code: "custom", message: "must not contain a URL fragment" });
  }
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "token")) {
    context.addIssue({ code: "custom", message: "must not contain a token query parameter; use BROWSERLESS_TOKEN" });
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.search) {
    context.addIssue({ code: "custom", message: "HTTP Browserless URLs must not contain query parameters" });
  }
  if ((url.protocol === "ws:" || url.protocol === "wss:") && !url.pathname.endsWith("/playwright")) {
    context.addIssue({ code: "custom", message: "WebSocket Browserless URLs must end in /playwright" });
  }
}

function validateBrowserlessToken(
  config: { BROWSERLESS_URL?: string; BROWSERLESS_TOKEN?: string },
  context: z.RefinementCtx,
): void {
  if (config.BROWSERLESS_TOKEN && !config.BROWSERLESS_URL) {
    context.addIssue({
      code: "custom",
      path: ["BROWSERLESS_TOKEN"],
      message: "requires BROWSERLESS_URL",
    });
  }
}

function validateStorageIsolation(
  config: { AGENT_SHARED_ROOT: string; MANAGED_FILE_ROOT: string },
  context: z.RefinementCtx,
): void {
  const sharedRoot = path.resolve(config.AGENT_SHARED_ROOT);
  const managedRoot = path.resolve(config.MANAGED_FILE_ROOT);

  if (isPathWithin(path.join(sharedRoot, "users"), managedRoot)) {
    context.addIssue({
      code: "custom",
      path: ["MANAGED_FILE_ROOT"],
      message: "must be outside AGENT_SHARED_ROOT/users so canonical chat files are never mounted into a thread sandbox",
    });
  }
}

function validateSandboxIdlePolicy(
  config: { OPEN_SANDBOX_IDLE_PAUSE_MS: number; OPEN_SANDBOX_IDLE_RELEASE_MS: number },
  context: z.RefinementCtx,
): void {
  if (config.OPEN_SANDBOX_IDLE_RELEASE_MS <= config.OPEN_SANDBOX_IDLE_PAUSE_MS) {
    context.addIssue({
      code: "custom",
      path: ["OPEN_SANDBOX_IDLE_RELEASE_MS"],
      message: "must be greater than OPEN_SANDBOX_IDLE_PAUSE_MS",
    });
  }
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
    OPEN_SANDBOX_API_KEY: "test-opensandbox",
  });
  const sharedRoot = path.resolve(overrides.AGENT_SHARED_ROOT ?? base.AGENT_SHARED_ROOT);
  return {
    ...base,
    DB_URL: "sqlite::memory:",
    AGENT_SHARED_ROOT: sharedRoot,
    OPEN_SANDBOX_SHARED_HOST_ROOT: sharedRoot,
    MANAGED_FILE_ROOT: overrides.MANAGED_FILE_ROOT ?? path.join(sharedRoot, ".chat-files"),
    DRAFT_UPDATE_MS: 0,
    ONBOARDING_TIMEZONE_DELAY_MS: 0,
    LOG_LEVEL: "error",
    ...overrides,
  };
}
