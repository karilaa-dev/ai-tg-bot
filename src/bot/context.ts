import type { ApplicationServices } from "../application/services.js";
import type { ConversationService } from "../application/conversations.js";
import type { Context } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { ThreadRow, UserRow } from "../db/types.js";
import type { TurnRunner } from "../ai/types.js";
import type { AcceptedFileType } from "../files/ingest.js";
import type { FileProcessingStatus } from "./files.js";
import type { ThreadTitleCoordinator } from "./threadTitles.js";
import type { CommandRuntime } from "../sandbox/types.js";
import type { TelegramTurnSource } from "../db/repos/turnRuns.js";

interface ActiveFileJob {
  controller: AbortController;
  status: FileProcessingStatus;
  cancel(): void;
}

export interface PendingMediaGroupItem {
  caption?: string;
  card: string;
  file: {
    id: string;
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

interface RouterState {
  activeFileJobs: Map<string, ActiveFileJob>;
  pendingMediaGroups: Map<string, PendingMediaGroup>;
  cancelledMediaGroups: Set<string>;
  pendingTextBursts: Map<string, PendingTextBurst>;
}

export function createRouterState(): RouterState {
  return {
    activeFileJobs: new Map<string, ActiveFileJob>(),
    pendingMediaGroups: new Map<string, PendingMediaGroup>(),
    cancelledMediaGroups: new Set<string>(),
    pendingTextBursts: new Map<string, PendingTextBurst>(),
  };
}

export interface BotServices extends ApplicationServices {
  conversations: ConversationService;
  turnRunner: TurnRunner;
  commandRuntime?: CommandRuntime;
  threadTitles: ThreadTitleCoordinator;
  routerState: RouterState;
}

export type BotContext = ConversationFlavor<Context> & {
  services: BotServices;
  user?: UserRow;
  thread?: ThreadRow;
  t: (key: string, params?: Record<string, string | number>) => string;
};
