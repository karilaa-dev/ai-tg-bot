import type { Context } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { ThreadRow, UserRow } from "../db/types.js";
import type { Logger } from "../logger.js";
import type { TurnRunner } from "../ai/run.js";
import type { AcceptedFileType } from "../files/ingest.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import type { FileProcessingStatus } from "./files.js";
import type { FileResolver } from "../files/resolver.js";
import type { ThreadTitleCoordinator } from "./threadTitles.js";
import type { CommandRuntime } from "../sandbox/types.js";
import type { ThreadTurnCoordinator } from "../ai/threadTurnCoordinator.js";
import type { TelegramTurnSource } from "../db/repos/turnRuns.js";

interface ActiveFileJob {
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
  source: TelegramTurnSource;
}

export interface PendingMediaGroup {
  ctx: BotContext;
  timer: NodeJS.Timeout;
  items: PendingMediaGroupItem[];
}

interface PendingTextBurst {
  ctx: BotContext;
  timer: NodeJS.Timeout;
  texts: string[];
  sources: TelegramTurnSource[];
}

export interface RouterState {
  activeFileJobs: Map<string, ActiveFileJob>;
  pendingMediaGroups: Map<string, PendingMediaGroup>;
  pendingTextBursts: Map<string, PendingTextBurst>;
}

export function createRouterState(): RouterState {
  return {
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
  turnCoordinator: ThreadTurnCoordinator;
  fileResolver: FileResolver;
  commandRuntime?: CommandRuntime;
  pi: PiRuntimeService;
  threadTitles: ThreadTitleCoordinator;
  routerState: RouterState;
}

export type BotContext = ConversationFlavor<Context> & {
  services: BotServices;
  user?: UserRow;
  thread?: ThreadRow;
  t: (key: string, params?: Record<string, string | number>) => string;
};
