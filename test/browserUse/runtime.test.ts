import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BrowserUseRuntimeError, BrowserUseRuntimeManager } from "../../src/browserUse/runtime.js";
import { BrowserUseHttpError } from "../../src/browserUse/client.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";

describe("BrowserUseRuntimeManager", () => {
  let database: AppDatabase | undefined;
  const managers: BrowserUseRuntimeManager[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
    await database?.destroy();
    database = undefined;
  });

  it("persists one profile across explicit close and a later session", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, 10);
    const browser = fixture.manager.forThread(7, 10);

    const opened = await browser.open("https://example.com");
    expect(opened).toMatchObject({ url: "https://example.com", session_remaining_seconds: expect.any(Number) });
    await expect(browser.closeSession()).resolves.toMatchObject({
      closed: true,
      tabs_closed: 1,
      profile_preserved: true,
    });
    await expect(browser.closeSession()).resolves.toEqual({
      closed: false,
      already_closed: true,
      profile_preserved: true,
    });

    await browser.open("https://example.org");
    expect(fixture.api.createProfile).toHaveBeenCalledTimes(1);
    expect(fixture.api.createBrowser).toHaveBeenCalledTimes(2);
    expect(fixture.api.createBrowser.mock.calls[0]![0].profileId)
      .toBe(fixture.api.createBrowser.mock.calls[1]![0].profileId);
    expect(fixture.api.createBrowser.mock.calls[0]![0]).toMatchObject({
      proxyCountryCode: null,
      enableRecording: false,
    });
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(1);
    expect(await fixture.repos.browserUseProfiles.get("test-browser", 7))
      .toMatchObject({ profile_id: PROFILE_ID, provider_user_key: expect.any(String) });
    const mapping = await fixture.repos.browserUseProfiles.get("test-browser", 7);
    expect(fixture.api.createProfile).toHaveBeenCalledWith({
      userId: mapping!.provider_user_key,
      name: expect.stringContaining(mapping!.provider_user_key.slice(0, 12)),
    }, undefined);
    expect(Object.keys(fixture.api.createProfile.mock.calls[0]![0])).toEqual(["userId", "name"]);
  });

  it("shares the user session while keeping tabs private to their threads", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, 10);
    await fixture.manager.forThread(7, 10).open("https://example.com/a");
    await fixture.manager.beginTurn(7, 20);
    const other = fixture.manager.forThread(7, 20);
    await other.open("https://example.com/b");

    await expect(other.listTabs()).resolves.toMatchObject({
      tabs: [expect.objectContaining({ url: "https://example.com/b" })],
    });
    await expect(other.closeSession()).rejects.toSatisfy((error: BrowserUseRuntimeError) => {
      expect(error.code).toBe("session_busy");
      return true;
    });

    await fixture.manager.endTurn(7, 10);
    const closed = await other.closeSession();
    expect(closed).toMatchObject({ closed: true, tabs_closed: 2 });
    expect(closed).not.toHaveProperty("urls");
    await expect(fixture.manager.forThread(7, 10).listTabs()).resolves.toMatchObject({ tabs: [] });
  });

  it("rolls a session over with the same profile and stable tab id", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, 10);
    const browser = fixture.manager.forThread(7, 10);
    const opened = await browser.open("https://example.com/long");

    await expect(browser.extendSession(20)).resolves.toMatchObject({
      extended: true,
      timeout_minutes: 20,
      reopened_tabs: 1,
      warning: expect.stringContaining("unsaved forms"),
    });
    const listed = await browser.listTabs();
    expect(listed.tabs).toEqual([
      expect.objectContaining({ tab_id: opened.tab_id, url: "https://example.com/long" }),
    ]);
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(1);
    expect(fixture.api.createBrowser.mock.calls[1]![0]).toMatchObject({ timeout: 20, profileId: PROFILE_ID });
  });

  it("retries transient stop failures twice and redacts cleanup credentials", async () => {
    const fixture = await runtimeFixture();
    fixture.api.stopBrowser
      .mockRejectedValueOnce(new BrowserUseHttpError(503, "temporary"))
      .mockRejectedValueOnce(new BrowserUseHttpError(503, "temporary"));
    await fixture.manager.beginTurn(7, 10);
    const browser = fixture.manager.forThread(7, 10);
    await browser.open("https://example.com");

    await expect(browser.closeSession()).resolves.toMatchObject({ closed: true });
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(3);

    await browser.open("https://example.org");
    fixture.api.stopBrowser.mockRejectedValue(
      new Error("test-key https://private.cdp.browser-use.test?token=visible"),
    );
    const error = await browser.closeSession().catch((failure: unknown) => failure);
    expect(String(error)).not.toContain("test-key");
    expect(String(error)).not.toContain("private.cdp");
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(6);
  });

  it("fails closed after the provider reports proxy usage", async () => {
    const fixture = await runtimeFixture();
    fixture.api.stopBrowser.mockResolvedValueOnce({
      id: "123e4567-e89b-12d3-a456-426614174999",
      status: "stopped",
      timeoutAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      cdpUrl: null,
      proxyUsedMb: "0.01",
      proxyCost: "0.001",
    });
    await fixture.manager.beginTurn(7, 10);
    const browser = fixture.manager.forThread(7, 10);
    await browser.open("https://example.com");

    await expect(browser.closeSession()).resolves.toMatchObject({ closed: true });
    await expect(browser.open("https://example.org")).rejects.toSatisfy((error: BrowserUseRuntimeError) => {
      expect(error.code).toBe("proxy_detected");
      return true;
    });
    expect(fixture.api.createBrowser).toHaveBeenCalledTimes(1);
  });

  it("closes Office contexts and cancels automatic cleanup timers on explicit close", async () => {
    vi.useFakeTimers();
    const fixture = await runtimeFixture({ BROWSER_USE_IDLE_TIMEOUT_MS: 1_000 });
    await fixture.manager.beginTurn(7, 10);
    const browser = fixture.manager.forThread(7, 10);
    await browser.open("https://example.com");
    await browser.renderOfficeHtml("<!doctype html><h1>Preview</h1>");
    const cloudBrowser = fixture.browsers[0]!;
    expect(cloudBrowser.contexts()).toHaveLength(2);

    await browser.closeSession();
    expect(cloudBrowser.contexts().every((context) => (context as unknown as FakeContext).closed)).toBe(true);
    await fixture.manager.endTurn(7, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(1);
  });

  it("automatically stops an idle session after the configured five-minute fallback", async () => {
    vi.useFakeTimers();
    const fixture = await runtimeFixture({ BROWSER_USE_IDLE_TIMEOUT_MS: 300_000 });
    await fixture.manager.beginTurn(7, 10);
    await fixture.manager.forThread(7, 10).open("https://example.com", 10);
    await fixture.manager.endTurn(7, 10);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(fixture.api.stopBrowser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(1);
  });

  async function runtimeFixture(overrides: Parameters<typeof loadTestConfig>[0] = {}) {
    database = createDatabase(loadTestConfig({ DB_URL: "sqlite::memory:" }));
    await database.initialize();
    const repos = createRepos(database.db, database.search);
    await repos.users.ensure({ tgId: 7, firstName: "Browser", lang: "en" });
    const api = fakeApi();
    const browsers: FakeBrowser[] = [];
    const manager = new BrowserUseRuntimeManager({
      config: loadTestConfig({
        BROWSER_USE_API_KEY: "test-key",
        BROWSER_USE_DEPLOYMENT_ID: "test-browser",
        ...overrides,
      }),
      repos,
      api,
      connect: async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return browser as unknown as Browser;
      },
    });
    managers.push(manager);
    return { manager, api, repos, browsers };
  }
});

const PROFILE_ID = "123e4567-e89b-12d3-a456-426614174001";

function fakeApi() {
  let session = 0;
  let profileRevision = 0;
  return {
    listProfiles: vi.fn(async () => []),
    createProfile: vi.fn(async ({ name, userId }: { name: string; userId: string }) => ({
      id: PROFILE_ID,
      name,
      userId,
    })),
    getProfile: vi.fn(async () => ({ id: PROFILE_ID, updatedAt: `2026-08-02T00:00:0${profileRevision}.000Z` })),
    createBrowser: vi.fn(async (input: { timeout: number; profileId: string }) => {
      session += 1;
      return {
        id: `123e4567-e89b-12d3-a456-${String(session).padStart(12, "0")}`,
        status: "active" as const,
        timeoutAt: new Date(Date.now() + input.timeout * 60_000).toISOString(),
        startedAt: new Date().toISOString(),
        cdpUrl: `https://session-${session}.cdp.browser-use.test`,
      };
    }),
    stopBrowser: vi.fn(async (id: string) => {
      profileRevision += 1;
      return {
        id,
        status: "stopped" as const,
        timeoutAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        cdpUrl: null,
        proxyUsedMb: "0",
        proxyCost: "0",
      };
    }),
    listDownloads: vi.fn(async () => ({ files: [], hasMore: false })),
  };
}

class FakeBrowser {
  connected = true;
  readonly context = new FakeContext();
  readonly allContexts = [this.context];

  contexts(): BrowserContext[] {
    return this.allContexts as unknown as BrowserContext[];
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.connected = false;
    await Promise.all(this.allContexts.map((context) => context.close()));
  }

  async newContext(): Promise<BrowserContext> {
    const context = new FakeContext();
    this.allContexts.push(context);
    return context as unknown as BrowserContext;
  }
}

class FakeContext {
  readonly pageList = [new FakePage()];
  closed = false;

  pages(): Page[] {
    return this.pageList as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.pageList.push(page);
    return page as unknown as Page;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.pageList.map((page) => page.close()));
  }
}

class FakePage {
  currentUrl = "about:blank";
  closed = false;
  scroll = { x: 0, y: 0 };
  closeListeners: Array<() => void> = [];

  async setViewportSize(): Promise<void> {}

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async waitForLoadState(): Promise<void> {}

  async setContent(): Promise<void> {}

  async waitForTimeout(): Promise<void> {}

  async screenshot(): Promise<Buffer> {
    return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  }

  async title(): Promise<string> {
    return `Title ${this.currentUrl}`;
  }

  on(): this {
    return this;
  }

  once(event: string, listener: () => void): this {
    if (event === "close") this.closeListeners.push(listener);
    return this;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes("window.scrollX")) return this.scroll as T;
    const match = expression.match(/window\.scrollTo\(([-\d]+), ([-\d]+)\)/);
    if (match) this.scroll = { x: Number(match[1]), y: Number(match[2]) };
    return undefined as T;
  }

  async opener(): Promise<Page | null> {
    return null;
  }
}
