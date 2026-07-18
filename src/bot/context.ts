import type { Context } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { TurnRunner } from "../ai/run.js";
import type { AcceptedFileType } from "../files/ingest.js";
import type { TextEmbedder } from "../memory/embeddings.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import type { FileProcessingStatus } from "./files.js";
import type { FileResolver } from "../files/resolver.js";

export interface ActiveFileJob {
  controller: AbortController;
  status: FileProcessingStatus;
}

export interface PendingMediaGroupItem {
  caption?: string;
  card: string;
  file: {
    id: number;
    type: AcceptedFileType;
    name: string;
    inline: boolean;
  };
}

export interface PendingMediaGroup {
  ctx: BotContext;
  timer: NodeJS.Timeout;
  items: PendingMediaGroupItem[];
}

export interface PendingTextBurst {
  ctx: BotContext;
  timer: NodeJS.Timeout;
  texts: string[];
}

export interface RouterState {
  awaitingCode: Set<number>;
  busyThreads: Set<number>;
  activeFileJobs: Map<string, ActiveFileJob>;
  pendingMediaGroups: Map<string, PendingMediaGroup>;
  pendingTextBursts: Map<string, PendingTextBurst>;
}

export function createRouterState(): RouterState {
  return {
    awaitingCode: new Set<number>(),
    busyThreads: new Set<number>(),
    activeFileJobs: new Map<string, ActiveFileJob>(),
    pendingMediaGroups: new Map<string, PendingMediaGroup>(),
    pendingTextBursts: new Map<string, PendingTextBurst>(),
  };
}

export interface BotServices {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  logger: Logger;
  turnRunner: TurnRunner;
  fileResolver: FileResolver;
  embedder?: TextEmbedder;
  pi: PiRuntimeService;
  routerState: RouterState;
}

export type BotContext = ConversationFlavor<Context> & {
  services: BotServices;
  user?: UserRow;
  thread?: ThreadRow;
  t: (key: string, params?: Record<string, string | number>) => string;
};
