import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileReadRequest,
  SandboxFileReadResult,
  SandboxSourceFileReadRequest,
} from "../sandbox/types.js";
import type { ThreadSandboxPool } from "./threadSandboxPool.js";

export class SandboxCommandExecutor {
  constructor(private readonly pool: ThreadSandboxPool) {}

  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return this.pool.execute(request);
  }

  readWorkspaceFile(request: SandboxFileReadRequest): Promise<SandboxFileReadResult> {
    return this.pool.readWorkspaceFile(request);
  }

  readSourceFile(request: SandboxSourceFileReadRequest): Promise<Buffer> {
    return this.pool.readSourceFile(request);
  }
}
