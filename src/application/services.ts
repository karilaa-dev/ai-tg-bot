import type { AccessControl } from "../access/control.js";
import type { ThreadTurnCoordinator } from "../ai/threadTurnCoordinator.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { Repos } from "../db/repos/index.js";
import type { FileResolver } from "../files/resolver.js";
import type { Logger } from "../logger.js";
import type { PiRuntimeService } from "../pi/runtime.js";
import type { ThreadRow } from "../db/types.js";

export interface ApplicationServices {
  config: AppConfig;
  db: AppDatabase;
  repos: Repos;
  logger: Logger;
  access: AccessControl;
  pi: PiRuntimeService;
  fileResolver: FileResolver;
  turnCoordinator: ThreadTurnCoordinator;
  cancelIncoming?(threadId: ThreadRow["id"]): boolean;
}
