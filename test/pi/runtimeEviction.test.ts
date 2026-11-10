import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";
import type { ThreadRow, UserRow } from "../../src/db/types.js";
import { deferred } from "../helpers/async.js";

const CACHE_LIMIT = 32;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Lease = Awaited<ReturnType<PiRuntimeManager["acquireRuntime"]>>;

async function harness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-eviction-"));
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: directory, CODEX_AUTH_FILE: path.join(directory, "missing-auth.json") });
  const db = createDatabase(config);
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user: UserRow = await repos.users.ensure({ tgId: 4_001, firstName: "Cache" });
  const manager = new PiRuntimeManager({ config, db, repos, logger: createLogger(config) });
  cleanups.push(async () => {
    await manager.dispose();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cache = () => (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;
  let topic = 0;
  const thread = (): Promise<ThreadRow> => repos.threads.create({ userId: user.tg_id, topicId: ++topic, title: `Thread ${topic}` });
  /** Creates idle cached runtimes for `count` fresh threads, oldest first. */
  async function fill(count: number, spyOnDispose?: (threadId: string, dispose: ReturnType<typeof vi.fn>) => void) {
    const threads: ThreadRow[] = [];
    for (let index = 0; index < count; index++) {
      const created = await thread();
      const runtime = await manager.runtime(created, user);
      // Strictly increasing recency, independent of the wall-clock resolution.
      runtime.lastUsedAt = index;
      if (spyOnDispose) spyOnDispose(created.id, vi.spyOn(runtime.session, "dispose"));
      threads.push(created);
    }
    return threads;
  }
  return { manager, repos, user, cache, thread, fill };
}

describe("Pi runtime cache ownership", () => {
  it("keeps a compacting runtime alive under cache pressure and evicts it once compaction finishes", async () => {
    const h = await harness();
    const target = await h.thread();
    const runtime = await h.manager.runtime(target, h.user);
    for (let index = 0; index < 4; index++) {
      runtime.session.sessionManager.appendMessage({ role: "user", content: `Context ${index} `.repeat(15_000), timestamp: index });
    }
    runtime.lastUsedAt = -1;
    const dispose = vi.spyOn(runtime.session, "dispose");
    const abortCompaction = vi.spyOn(runtime.session, "abortCompaction");
    const compaction = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(runtime.session, "compact").mockImplementation(async () => {
      started.resolve();
      await compaction.promise;
      runtime.session.sessionManager.appendCompaction("Earlier requests", runtime.session.sessionManager.getLeafId()!, 1000);
      return {} as never;
    });
    // The SDK cannot report this state before it starts its own compaction work.
    expect(runtime.session.isStreaming).toBe(false);

    const execution = h.manager.compact(target, h.user);
    await started.promise;
    // A long compaction is older than every runtime created after it began.
    runtime.lastUsedAt = -1;
    await h.fill(CACHE_LIMIT + 2);

    expect(dispose).not.toHaveBeenCalled();
    expect(abortCompaction).not.toHaveBeenCalled();
    expect(h.cache().get(target.id)).toBe(runtime);
    compaction.resolve();
    await expect(execution).resolves.toBeGreaterThanOrEqual(0);

    // The released runtime is back to being an ordinary idle cache entry within the bound.
    expect(h.cache().size).toBe(CACHE_LIMIT);
    expect(dispose).not.toHaveBeenCalled();
    runtime.lastUsedAt = -1;
    await h.manager.runtime(await h.thread(), h.user);
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.cache().has(target.id)).toBe(false);
    expect(h.cache().size).toBe(CACHE_LIMIT);
  });

  it("keeps an acquired runtime and its outgoing files until the operation is released", async () => {
    const h = await harness();
    const target = await h.thread();
    const lease = await h.manager.acquireRuntime(target, h.user);
    lease.runtime.lastUsedAt = -1;
    const dispose = vi.spyOn(lease.runtime.session, "dispose");
    const endTurn = vi.spyOn(lease.runtime.bridge, "endTurn");
    // Model streaming never starts: preparation and final delivery are not streaming.
    expect(lease.runtime.session.isStreaming).toBe(false);

    await h.fill(CACHE_LIMIT + 3);

    expect(dispose).not.toHaveBeenCalled();
    expect(endTurn).not.toHaveBeenCalled();
    expect(h.cache().get(target.id)).toBe(lease.runtime);
    expect(h.cache().size).toBe(CACHE_LIMIT);

    await lease.release();
    // The release prunes immediately instead of waiting for the next request.
    expect(h.cache().size).toBe(CACHE_LIMIT);
    expect(dispose).not.toHaveBeenCalled();
    expect(endTurn).not.toHaveBeenCalled();
    lease.runtime.lastUsedAt = -1;
    await h.manager.runtime(await h.thread(), h.user);
    expect(dispose).toHaveBeenCalledOnce();
    expect(endTurn).toHaveBeenCalledOnce();
    expect(h.cache().has(target.id)).toBe(false);
    expect(h.cache().size).toBe(CACHE_LIMIT);
  });

  it("releases ownership when the owner fails, is aborted or releases twice", async () => {
    const h = await harness();
    const failing = await h.thread();
    const controller = new AbortController();
    controller.abort(new Error("barrier lease was lost"));
    // fork observes the abort after acquiring the runtime and must still release it.
    await expect(h.manager.fork(failing, await h.thread(), h.user, null, controller.signal)).rejects.toThrow("barrier lease was lost");
    const runtime = await h.manager.runtime(failing, h.user);
    persist(runtime);
    runtime.lastUsedAt = -1;
    const dispose = vi.spyOn(runtime.session, "dispose");
    await expect(h.manager.compact(failing, h.user)).rejects.toMatchObject({ reason: "too_small" });
    expect(owners(h.cache().get(failing.id))).toBe(0);

    const lease = await h.manager.acquireRuntime(failing, h.user);
    expect(lease.runtime).toBe(runtime);
    await lease.release();
    await lease.release();
    expect(owners(h.cache().get(failing.id))).toBe(0);

    runtime.lastUsedAt = -1;
    await h.fill(CACHE_LIMIT);
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.cache().size).toBe(CACHE_LIMIT);
  });

  it("exceeds the cache bound while every runtime is owned and prunes after the releases", async () => {
    const h = await harness();
    const leases: Lease[] = [];
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    for (let index = 0; index < CACHE_LIMIT + 2; index++) {
      const lease = await h.manager.acquireRuntime(await h.thread(), h.user);
      lease.runtime.lastUsedAt = index;
      disposals.push(vi.spyOn(lease.runtime.session, "dispose"));
      leases.push(lease);
    }
    expect(h.cache().size).toBe(CACHE_LIMIT + 2);
    expect(disposals.every(dispose => !dispose.mock.calls.length)).toBe(true);

    // Only released runtimes are eligible, so owned ones survive until their own release.
    await leases[CACHE_LIMIT + 1]!.release();
    expect(h.cache().size).toBe(CACHE_LIMIT + 1);
    expect(disposals.map(dispose => dispose.mock.calls.length).filter(Boolean)).toEqual([1]);
    expect(disposals[CACHE_LIMIT + 1]).toHaveBeenCalledOnce();
    await leases[CACHE_LIMIT]!.release();
    expect(h.cache().size).toBe(CACHE_LIMIT);
    expect(disposals[CACHE_LIMIT]).toHaveBeenCalledOnce();

    // At the bound, releasing the rest keeps them cached.
    for (const lease of leases.slice(0, CACHE_LIMIT).toReversed()) await lease.release();
    expect(h.cache().size).toBe(CACHE_LIMIT);
    expect(disposals.slice(0, CACHE_LIMIT).every(dispose => !dispose.mock.calls.length)).toBe(true);
  });

  it("serves concurrent acquisitions of one thread from a single runtime", async () => {
    const h = await harness();
    const target = await h.thread();
    const initial = await h.manager.acquireRuntime(target, h.user);
    persist(initial.runtime);
    await initial.release();
    const [first, second] = await Promise.all([
      h.manager.acquireRuntime(target, h.user), h.manager.acquireRuntime(target, h.user),
    ]);
    expect(first.runtime).toBe(initial.runtime);
    expect(second.runtime).toBe(first.runtime);
    expect(h.cache().size).toBe(1);
    expect(owners(h.cache().get(target.id))).toBe(2);
    const dispose = vi.spyOn(first.runtime.session, "dispose");
    await first.release();
    first.runtime.lastUsedAt = -1;
    await h.fill(CACHE_LIMIT + 1);
    // One owner remains, so the oldest runtime is still pinned.
    expect(dispose).not.toHaveBeenCalled();
    expect(h.cache().get(target.id)).toBe(first.runtime);
    await second.release();
    second.runtime.lastUsedAt = -1;
    await h.manager.runtime(await h.thread(), h.user);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("never leaks a session when one thread is created concurrently", async () => {
    const h = await harness();
    const target = await h.thread();
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    try {
      const leases = await Promise.all([h.manager.acquireRuntime(target, h.user), h.manager.acquireRuntime(target, h.user)]);
      // An empty transcript is rebuilt on reacquisition; the superseded runtime stays usable by its owner.
      expect(h.cache().size).toBe(1);
      const [superseded, current] = leases[0].runtime === h.cache().get(target.id) ? [leases[1], leases[0]] : [leases[0], leases[1]];
      expect(current.runtime).toBe(h.cache().get(target.id));
      expect(superseded.runtime).not.toBe(current.runtime);
      expect(dispose).not.toHaveBeenCalled();
      await superseded.release();
      expect(dispose).toHaveBeenCalledOnce();
      expect(dispose.mock.instances[0]).toBe(superseded.runtime.session);
      await current.release();
      expect(dispose).toHaveBeenCalledOnce();
      expect(h.cache().get(target.id)).toBe(current.runtime);
    } finally { dispose.mockRestore(); }
  });

  it("does not hand out a runtime whose eviction cleanup is still running, nor let it remove its replacement", async () => {
    const h = await harness();
    const [victim] = await h.fill(CACHE_LIMIT);
    const original = h.cache().get(victim!.id) as { session: { dispose(): void }; bridge: { endTurn(): Promise<void> } };
    const cleanup = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(original.bridge, "endTurn").mockImplementation(async () => { entered.resolve(); await cleanup.promise; });
    const dispose = vi.spyOn(original.session, "dispose");

    const pressure = h.manager.runtime(await h.thread(), h.user);
    await entered.promise;
    // The victim leaves the cache before its cleanup awaits, so it cannot be returned half-disposed.
    expect(h.cache().has(victim!.id)).toBe(false);
    let settled = false;
    const reacquired = h.manager.acquireRuntime(victim!, h.user).then(lease => { settled = true; return lease; });
    for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(dispose).not.toHaveBeenCalled();

    cleanup.resolve();
    await pressure;
    const lease = await reacquired;
    expect(dispose).toHaveBeenCalledOnce();
    expect(lease.runtime).not.toBe(original);
    expect(h.cache().get(victim!.id)).toBe(lease.runtime);
    const replacementDispose = vi.spyOn(lease.runtime.session, "dispose");
    await h.fill(1);
    await lease.release();
    expect(replacementDispose).not.toHaveBeenCalled();
    expect(h.cache().get(victim!.id)).toBe(lease.runtime);
  });

  it("shuts down owned and idle runtimes without waiting for their owners", async () => {
    const h = await harness();
    const lease = await h.manager.acquireRuntime(await h.thread(), h.user);
    const idle = await h.manager.runtime(await h.thread(), h.user);
    const owned = vi.spyOn(lease.runtime.session, "dispose");
    const spare = vi.spyOn(idle.session, "dispose");
    await h.manager.dispose();
    expect(owned).toHaveBeenCalledOnce();
    expect(spare).toHaveBeenCalledOnce();
    expect(h.cache().size).toBe(0);
    await lease.release();
    expect(owned).toHaveBeenCalledOnce();
  });
});

/** A session without messages has no transcript file and is rebuilt whenever it is reacquired. */
function persist(runtime: { session: { sessionManager: { appendMessage(message: never): unknown } } }) {
  runtime.session.sessionManager.appendMessage({ role: "user", content: "Persist this transcript", timestamp: 1 } as never);
}

function owners(entry: unknown): number {
  return (entry as { owners: number } | undefined)?.owners ?? -1;
}
