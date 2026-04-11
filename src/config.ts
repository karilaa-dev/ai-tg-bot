import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { DatabaseClient } from './domain.js';

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1),
  OPENROUTER_REASONING_EFFORT: z
    .enum(['xhigh', 'high', 'medium', 'low', 'minimal', 'none'])
    .default('medium'),
  MORPH_API_KEY: z.string().min(1),
  DATABASE_CLIENT: z.enum(['sqlite3', 'pg']).default('sqlite3'),
  DATABASE_URL: z.string().optional(),
  SQLITE_FILENAME: z.string().default('./data/bot.sqlite3'),
  BOT_NAME: z.string().default('Threaded AI Bot'),
  TZ: z.string().default('UTC'),
});

export interface AppConfig {
  telegramBotToken: string;
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterReasoningEffort: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  morphApiKey: string;
  databaseClient: DatabaseClient;
  databaseUrl: string | null;
  sqliteFilename: string;
  botName: string;
  timezone: string;
  systemPromptPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(env);

  if (parsed.DATABASE_CLIENT === 'pg' && !parsed.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when DATABASE_CLIENT=pg');
  }

  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    openRouterApiKey: parsed.OPENROUTER_API_KEY,
    openRouterModel: parsed.OPENROUTER_MODEL,
    openRouterReasoningEffort: parsed.OPENROUTER_REASONING_EFFORT,
    morphApiKey: parsed.MORPH_API_KEY,
    databaseClient: parsed.DATABASE_CLIENT,
    databaseUrl: parsed.DATABASE_URL ?? null,
    sqliteFilename: parsed.SQLITE_FILENAME,
    botName: parsed.BOT_NAME,
    timezone: parsed.TZ,
    systemPromptPath: fileURLToPath(new URL('../SYS_PROMPT.md', import.meta.url)),
  };
}
