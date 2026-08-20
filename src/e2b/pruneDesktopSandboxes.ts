export interface PrunableSandboxInfo {
  sandboxId: string;
  name?: string;
  state: "running" | "paused";
  metadata: Record<string, string>;
}

export interface DesktopSandboxAdminClient {
  list(): Promise<PrunableSandboxInfo[]>;
  getInfo(sandboxId: string): Promise<PrunableSandboxInfo>;
  kill(sandboxId: string): Promise<void>;
}

export interface SandboxMappingRemover {
  removeBySandboxIds(sandboxIds: string[]): Promise<void>;
}

export interface DesktopPruneResult {
  execute: boolean;
  matched: PrunableSandboxInfo[];
  deleted: string[];
  skipped: Array<{ sandboxId: string; reason: string }>;
  failed: Array<{ sandboxId: string; error: string }>;
  remaining: PrunableSandboxInfo[];
}

export function isLegacyDesktopSandbox(info: PrunableSandboxInfo): boolean {
  return info.metadata.app === "ai-tg-bot"
    && info.name === "desktop"
    && (info.state === "running" || info.state === "paused");
}

export async function pruneLegacyDesktopSandboxes(input: {
  execute: boolean;
  client: DesktopSandboxAdminClient;
  mappings: SandboxMappingRemover;
  concurrency?: number;
}): Promise<DesktopPruneResult> {
  const matched = (await input.client.list()).filter(isLegacyDesktopSandbox);
  if (!input.execute) {
    return { execute: false, matched, deleted: [], skipped: [], failed: [], remaining: matched };
  }

  const results = await mapConcurrent(matched, input.concurrency ?? 4, async (candidate) => {
    try {
      const current = await retryOnce(() => input.client.getInfo(candidate.sandboxId));
      if (!isLegacyDesktopSandbox(current)) {
        return { kind: "skipped" as const, sandboxId: candidate.sandboxId, reason: "sandbox no longer matches the guarded Desktop selection" };
      }
      await retryOnce(() => input.client.kill(candidate.sandboxId));
      return { kind: "deleted" as const, sandboxId: candidate.sandboxId };
    } catch (error) {
      return { kind: "failed" as const, sandboxId: candidate.sandboxId, error: sanitizeError(error) };
    }
  });

  const deleted = results.filter((result) => result.kind === "deleted").map((result) => result.sandboxId);
  const skipped = results.filter((result) => result.kind === "skipped").map((result) => ({
    sandboxId: result.sandboxId,
    reason: result.reason,
  }));
  const failed = results.filter((result) => result.kind === "failed").map((result) => ({
    sandboxId: result.sandboxId,
    error: result.error,
  }));
  await input.mappings.removeBySandboxIds(deleted);
  const remaining = (await input.client.list()).filter(isLegacyDesktopSandbox);
  return { execute: true, matched, deleted, skipped, failed, remaining };
}

async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/e2b_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}
