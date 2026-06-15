import type { Context } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { ImageCaptioner } from "../ai/provider.js";
import type { TurnRunner } from "../ai/run.js";
import type { TelegramFileDownloader } from "../files/telegram.js";
import type { ConversationSummarizer } from "../memory/compactor.js";
import type { TextEmbedder } from "../memory/embeddings.js";

export interface BotServices {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  logger: Logger;
  turnRunner: TurnRunner;
  downloadFile: TelegramFileDownloader;
  embedder?: TextEmbedder;
  imageCaptioner?: ImageCaptioner;
  summarizer?: ConversationSummarizer;
}

export type BotContext = ConversationFlavor<Context> & {
  services: BotServices;
  user?: UserRow;
  thread?: ThreadRow;
  t: (key: string, params?: Record<string, string | number>) => string;
};
