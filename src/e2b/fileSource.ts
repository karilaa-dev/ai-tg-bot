import type { AppConfig } from "../config.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import type { ChatFileSource, ChatFileSourceAdapter } from "../files/source.js";
import type { CommandRuntime, SandboxFileReadResult } from "../sandbox/types.js";

function e2bConnectionKey(config: Pick<AppConfig, "E2B_DEPLOYMENT_ID">): string {
  return config.E2B_DEPLOYMENT_ID;
}

export function e2bFileSource(
  config: Pick<AppConfig, "E2B_DEPLOYMENT_ID">,
  input: Pick<SandboxFileReadResult, "sandboxId" | "size" | "contentSha256"> & {
    fileId: number;
    sourceCanonicalPath: string;
    userId: number;
    threadId: number;
    mimeType?: string | null;
  },
): ChatFileSource {
  return {
    transport: "e2b",
    connectionKey: e2bConnectionKey(config),
    remoteKey: `${input.sandboxId}:file:${input.fileId}:sha256:${input.contentSha256}`,
    locator: {
      sandbox_id: input.sandboxId,
      user_id: input.userId,
      thread_id: input.threadId,
      path: input.sourceCanonicalPath,
      size: input.size,
      sha256: input.contentSha256,
    },
    mimeType: input.mimeType ?? null,
  };
}

export class E2BFileSourceAdapter implements ChatFileSourceAdapter {
  readonly transport = "e2b";
  readonly connectionKey: string;

  constructor(
    config: Pick<AppConfig, "E2B_DEPLOYMENT_ID">,
    private readonly runtime: CommandRuntime,
  ) {
    this.connectionKey = e2bConnectionKey(config);
  }

  fetch(source: ChatFileSource, signal?: AbortSignal): Promise<Buffer> {
    const sandboxId = source.locator.sandbox_id;
    const userId = source.locator.user_id;
    const threadId = source.locator.thread_id;
    const canonicalPath = source.locator.path;
    if (typeof sandboxId !== "string" || !sandboxId) throw new Error("E2B source has no sandbox_id.");
    if (typeof canonicalPath !== "string" || !canonicalPath) throw new Error("E2B source has no path.");
    if (!Number.isSafeInteger(userId) || Number(userId) <= 0) throw new Error("E2B source has no valid user_id.");
    if (!Number.isSafeInteger(threadId) || Number(threadId) <= 0) throw new Error("E2B source has no valid thread_id.");
    return this.runtime.readSourceFile({
      sandboxId,
      userId: Number(userId),
      threadId: Number(threadId),
      canonicalPath,
      maxBytes: MAX_FILE_BYTES,
      signal,
    });
  }
}
