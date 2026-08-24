import type {
  SandboxFileMaterializeRequest,
  SandboxThreadFileSyncResult,
} from "../sandbox/types.js";
import type { ThreadSandboxPool } from "./threadSandboxPool.js";

export class TelegramFileMaterializer {
  constructor(private readonly pool: ThreadSandboxPool) {}

  materializeFiles(request: SandboxFileMaterializeRequest): Promise<SandboxThreadFileSyncResult> {
    return this.pool.materializeFiles(request);
  }
}
