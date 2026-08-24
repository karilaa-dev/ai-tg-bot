import type {
  CommandRuntime,
  PublishWebsiteRequest,
  PublishedWebsite,
  SandboxActivityLease,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileMaterializeRequest,
  SandboxFileReadRequest,
  SandboxFileReadResult,
  SandboxSourceFileReadRequest,
  SandboxThreadFileSyncResult,
} from "../sandbox/types.js";
import { SandboxCommandExecutor } from "./sandboxCommandExecutor.js";
import { TelegramFileMaterializer } from "./telegramFileMaterializer.js";
import { ThreadSandboxPool, type ThreadSandboxPoolInput } from "./threadSandboxPool.js";
import { WebsitePublisher } from "./websitePublisher.js";

/** Small facade that keeps transport-specific E2B services out of agent tools. */
export class ThreadE2BSandboxRuntimeManager implements CommandRuntime {
  private readonly pool: ThreadSandboxPool;
  private readonly commands: SandboxCommandExecutor;
  private readonly materializer: TelegramFileMaterializer;
  private readonly websites: WebsitePublisher;

  constructor(input: ThreadSandboxPoolInput) {
    this.pool = new ThreadSandboxPool(input);
    this.commands = new SandboxCommandExecutor(this.pool);
    this.materializer = new TelegramFileMaterializer(this.pool);
    this.websites = new WebsitePublisher(this.pool);
  }

  acquireActivityLease(userId: number, threadId: number): SandboxActivityLease {
    return this.pool.acquireActivityLease(userId, threadId);
  }

  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return this.commands.execute(request);
  }

  materializeFiles(request: SandboxFileMaterializeRequest): Promise<SandboxThreadFileSyncResult> {
    return this.materializer.materializeFiles(request);
  }

  readWorkspaceFile(request: SandboxFileReadRequest): Promise<SandboxFileReadResult> {
    return this.commands.readWorkspaceFile(request);
  }

  readSourceFile(request: SandboxSourceFileReadRequest): Promise<Buffer> {
    return this.commands.readSourceFile(request);
  }

  publishWebsite(request: PublishWebsiteRequest): Promise<PublishedWebsite> {
    return this.websites.publishWebsite(request);
  }

  dispose(): Promise<void> {
    return this.pool.dispose();
  }
}
