import { readFile } from 'node:fs/promises';

import type { AppConfig } from './config.js';
import type { ChatThreadRecord, PromptContext } from './domain.js';

function escapeReplacement(value: string): string {
  return value.replaceAll('$', '$$$$');
}

export function buildPromptContext(input: {
  config: AppConfig;
  userName: string;
  userLang: string;
}): PromptContext {
  const now = new Date();

  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: input.config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  return {
    modelName: input.config.openRouterModel,
    botName: input.config.botName,
    time,
    timezone: input.config.timezone,
    date,
    userName: input.userName,
    userLang: input.userLang,
  };
}

export async function renderSystemPrompt(input: {
  config: AppConfig;
  userName: string;
  userLang: string;
  thread: ChatThreadRecord;
}): Promise<string> {
  const template = await readFile(input.config.systemPromptPath, 'utf8');
  const context = buildPromptContext({
    config: input.config,
    userName: input.userName,
    userLang: input.userLang,
  });

  const rendered = template
    .replaceAll('{model_name}', escapeReplacement(context.modelName))
    .replaceAll('{bot_name}', escapeReplacement(context.botName))
    .replaceAll('{time}', escapeReplacement(context.time))
    .replaceAll('{timezone}', escapeReplacement(context.timezone))
    .replaceAll('{date}', escapeReplacement(context.date))
    .replaceAll('{user_name}', escapeReplacement(context.userName))
    .replaceAll('{user_lang}', escapeReplacement(context.userLang));

  if (!input.thread.compactMessage) {
    return rendered;
  }

  return `${rendered}\n\nConversation summary:\n${input.thread.compactMessage}`;
}
