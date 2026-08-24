import type { PublishWebsiteRequest, PublishedWebsite } from "../sandbox/types.js";
import type { ThreadSandboxPool } from "./threadSandboxPool.js";

export class WebsitePublisher {
  constructor(private readonly pool: ThreadSandboxPool) {}

  publishWebsite(request: PublishWebsiteRequest): Promise<PublishedWebsite> {
    return this.pool.publishWebsite(request);
  }
}
