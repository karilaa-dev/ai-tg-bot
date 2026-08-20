import { describe, expect, it } from "vitest";
import {
  pruneLegacyDesktopSandboxes,
  type DesktopSandboxAdminClient,
  type PrunableSandboxInfo,
  type SandboxMappingRemover,
} from "../../src/e2b/pruneDesktopSandboxes.js";

describe("legacy E2B Desktop sandbox pruning", () => {
  it("is a non-mutating dry run and includes primary and smoke deployments", async () => {
    const client = new FakeAdminClient([
      sandbox("primary", "desktop", { app: "ai-tg-bot", deployment: "ai-tg-bot" }),
      sandbox("smoke", "desktop", { app: "ai-tg-bot", deployment: "ai-tg-bot-smoke-123" }),
      sandbox("custom", "ai-tg-bot-tools:production", { app: "ai-tg-bot" }),
      sandbox("unrelated", "desktop", { app: "other" }),
      sandbox("unlabelled", "desktop", {}),
    ]);
    const mappings = new FakeMappings();

    const result = await pruneLegacyDesktopSandboxes({ execute: false, client, mappings });

    expect(result.matched.map((item) => item.sandboxId)).toEqual(["primary", "smoke"]);
    expect(client.killed).toEqual([]);
    expect(mappings.removed).toEqual([]);
  });

  it("revalidates, deletes with retries, and removes only successful mappings", async () => {
    const client = new FakeAdminClient([
      sandbox("deleted", "desktop", { app: "ai-tg-bot", deployment: "ai-tg-bot" }),
      sandbox("changed", "desktop", { app: "ai-tg-bot", deployment: "ai-tg-bot" }),
      sandbox("failed", "desktop", { app: "ai-tg-bot", deployment: "ai-tg-bot-smoke-x" }),
    ]);
    client.afterList.set("changed", sandbox("changed", "ai-tg-bot-tools:production", { app: "ai-tg-bot" }));
    client.killFailures.set("deleted", 1);
    client.killFailures.set("failed", 2);
    const mappings = new FakeMappings();

    const result = await pruneLegacyDesktopSandboxes({ execute: true, client, mappings, concurrency: 2 });

    expect(result.deleted).toEqual(["deleted"]);
    expect(result.skipped).toEqual([{ sandboxId: "changed", reason: expect.stringContaining("no longer matches") }]);
    expect(result.failed).toEqual([{ sandboxId: "failed", error: "kill failed" }]);
    expect(mappings.removed).toEqual(["deleted"]);
    expect(result.remaining.map((item) => item.sandboxId)).toEqual(["failed"]);
  });

  it("is idempotent after successful cleanup", async () => {
    const client = new FakeAdminClient([]);
    const mappings = new FakeMappings();
    const result = await pruneLegacyDesktopSandboxes({ execute: true, client, mappings });
    expect(result).toMatchObject({ matched: [], deleted: [], failed: [], remaining: [] });
  });
});

class FakeAdminClient implements DesktopSandboxAdminClient {
  readonly current = new Map<string, PrunableSandboxInfo>();
  readonly afterList = new Map<string, PrunableSandboxInfo>();
  readonly killFailures = new Map<string, number>();
  readonly killed: string[] = [];

  constructor(sandboxes: PrunableSandboxInfo[]) {
    for (const item of sandboxes) this.current.set(item.sandboxId, item);
  }

  async list(): Promise<PrunableSandboxInfo[]> {
    return [...this.current.values()];
  }

  async getInfo(sandboxId: string): Promise<PrunableSandboxInfo> {
    const replacement = this.afterList.get(sandboxId);
    if (replacement) {
      this.current.set(sandboxId, replacement);
      this.afterList.delete(sandboxId);
    }
    const item = this.current.get(sandboxId);
    if (!item) throw new Error("missing");
    return item;
  }

  async kill(sandboxId: string): Promise<void> {
    const failures = this.killFailures.get(sandboxId) ?? 0;
    if (failures > 0) {
      this.killFailures.set(sandboxId, failures - 1);
      throw new Error("kill failed");
    }
    this.killed.push(sandboxId);
    this.current.delete(sandboxId);
  }
}

class FakeMappings implements SandboxMappingRemover {
  readonly removed: string[] = [];
  async removeBySandboxIds(sandboxIds: string[]): Promise<void> {
    this.removed.push(...sandboxIds);
  }
}

function sandbox(
  sandboxId: string,
  name: string,
  metadata: Record<string, string>,
): PrunableSandboxInfo {
  return { sandboxId, name, metadata, state: "paused" };
}
