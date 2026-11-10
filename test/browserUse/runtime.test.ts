import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BrowserUseRuntimeManager } from "../../src/browserUse/runtime.js";
import { BrowserUseRuntimeError } from "../../src/browserUse/pageOperations.js";
import { BrowserUseHttpError } from "../../src/browserUse/client.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { deferred } from "../helpers/async.js";

const THREAD_ID = "123e4567-e89b-42d3-a456-426614174010";
const OTHER_THREAD_ID = "123e4567-e89b-42d3-a456-426614174020";

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
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);

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

  it("waits for profile persistence when the initial storage snapshot is unavailable", async () => {
    const fixture = await runtimeFixture({}, true);
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
    await browser.open("https://example.com/login");

    await browser.closeSession();

    expect(fixture.api.getProfile.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("reports when an existing session cannot apply a longer open timeout", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
    await browser.open("https://example.com/short", 5);

    await expect(browser.open("https://example.com/long", 20)).resolves.toMatchObject({
      requested_timeout_minutes: 20,
      timeout_request_applied: false,
      effective_session_timeout_minutes: 5,
      extension_required: true,
      extension_hint: expect.stringContaining("browser_extend_session"),
    });
    expect(fixture.api.createBrowser).toHaveBeenCalledTimes(1);
  });

  it("shares the user session while keeping tabs private to their threads", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, THREAD_ID);
    await fixture.manager.forThread(7, THREAD_ID).open("https://example.com/a");
    await fixture.manager.beginTurn(7, OTHER_THREAD_ID);
    const other = fixture.manager.forThread(7, OTHER_THREAD_ID);
    await other.open("https://example.com/b");

    await expect(other.listTabs()).resolves.toMatchObject({
      tabs: [expect.objectContaining({ url: "https://example.com/b" })],
    });
    await expect(other.closeSession()).rejects.toSatisfy((error: BrowserUseRuntimeError) => {
      expect(error.code).toBe("session_busy");
      return true;
    });

    await fixture.manager.endTurn(7, THREAD_ID);
    const closed = await other.closeSession();
    expect(closed).toMatchObject({ closed: true, tabs_closed: 2 });
    expect(closed).not.toHaveProperty("urls");
    await expect(fixture.manager.forThread(7, THREAD_ID).listTabs()).resolves.toMatchObject({ tabs: [] });
  });

  it("rolls a session over with the same profile and stable tab id", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
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
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
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
    // A failed provider stop must retain the session so it can be retried,
    // rather than quietly creating another billable browser.
    await expect(browser.open("https://example.net")).rejects.toThrow();
    expect(fixture.api.createBrowser).toHaveBeenCalledTimes(2);
    fixture.api.stopBrowser.mockImplementation(async (id) => stoppedBrowser(id));
    await expect(browser.closeSession()).resolves.toMatchObject({ closed: true });
  });

  it("does not poison later no-proxy sessions when the provider reports proxy usage", async () => {
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
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
    await browser.open("https://example.com");

    await expect(browser.closeSession()).resolves.toMatchObject({ closed: true });
    await expect(browser.open("https://example.org")).resolves.toMatchObject({ url: "https://example.org" });
    expect(fixture.api.createBrowser).toHaveBeenCalledTimes(2);
  });

  it("automatically stops an idle session after the configured five-minute fallback", async () => {
    vi.useFakeTimers();
    const fixture = await runtimeFixture({ BROWSER_USE_IDLE_TIMEOUT_MS: 300_000 });
    await fixture.manager.beginTurn(7, THREAD_ID);
    await fixture.manager.forThread(7, THREAD_ID).open("https://example.com", 10);
    await fixture.manager.endTurn(7, THREAD_ID);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(fixture.api.stopBrowser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.api.stopBrowser).toHaveBeenCalledTimes(1);
  });

  it("returns the semantic snapshot when its optional PNG is too large", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
    const opened = await browser.open("https://example.com/graphics");
    fixture.browsers[0]!.context.pageList[0]!.screenshotBytes = Buffer.alloc(20 * 1024 * 1024 + 1);

    const snapshot = await browser.snapshot(String(opened.tab_id), 0, true);

    expect(snapshot).toMatchObject({ snapshot: "Page content", url: "https://example.com/graphics" });
    expect(snapshot).not.toHaveProperty("screenshot_base64");
    expect(snapshot).not.toHaveProperty("screenshot_media_type");
    expect(snapshot).not.toHaveProperty("screenshot_size");
  });

  it("releases a queued browser lock when the queued action is cancelled", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
    const opened = await browser.open("https://example.com/start");
    const page = fixture.browsers[0]!.context.pageList[0]!;
    const started = deferred<void>();
    const release = deferred<void>();
    page.nextGotoGate = { started, release };
    const active = browser.navigate(String(opened.tab_id), "https://example.com/blocked");
    await started.promise;

    const controller = new AbortController();
    const cancelled = browser.snapshot(String(opened.tab_id), 0, false, controller.signal);
    controller.abort(new Error("stopped"));
    const later = browser.listTabs();
    release.resolve();

    await expect(active).resolves.toMatchObject({ url: "https://example.com/blocked" });
    await expect(cancelled).rejects.toThrow("stopped");
    await expect(later).resolves.toMatchObject({ tabs: [expect.any(Object)] });
  });

  it("retains user state while a browser operation is queued behind endTurn", async () => {
    const fixture = await runtimeFixture();
    await fixture.manager.beginTurn(7, THREAD_ID);
    const browser = fixture.manager.forThread(7, THREAD_ID);
    await browser.open("https://example.com/first");
    const stopStarted = deferred<void>();
    const releaseStop = deferred<void>();
    fixture.api.stopBrowser.mockImplementationOnce(async (id: string) => {
      stopStarted.resolve();
      await releaseStop.promise;
      return stoppedBrowser(id);
    });
    const createStarted = deferred<void>();
    const releaseCreate = deferred<void>();
    fixture.api.createBrowser.mockImplementationOnce(async (input: { timeout: number }) => {
      createStarted.resolve();
      await releaseCreate.promise;
      return activeBrowser("123e4567-e89b-12d3-a456-426614174777", input.timeout);
    });

    const closing = browser.closeSession();
    await stopStarted.promise;
    const ending = fixture.manager.endTurn(7, THREAD_ID);
    const reopening = browser.open("https://example.com/second");
    releaseStop.resolve();
    await createStarted.promise;
    await ending;
    releaseCreate.resolve();

    await expect(closing).resolves.toMatchObject({ closed: true });
    await expect(reopening).resolves.toMatchObject({ url: "https://example.com/second" });
    await expect(fixture.manager.forThread(7, THREAD_ID).listTabs()).resolves.toMatchObject({
      tabs: [expect.objectContaining({ url: "https://example.com/second" })],
    });
  });

  describe("download ownership", () => {
    type File = { path: string; size: number; lastModified: string; url?: string };
    async function twoTabs() {
      const fixture = await runtimeFixture();
      await fixture.manager.beginTurn(7, THREAD_ID);
      await fixture.manager.beginTurn(7, OTHER_THREAD_ID);
      const first = fixture.manager.forThread(7, THREAD_ID);
      const second = fixture.manager.forThread(7, OTHER_THREAD_ID);
      const a = await first.open("https://example.com/a") as { tab_id: string };
      const b = await second.open("https://example.com/b") as { tab_id: string };
      const pages = fixture.browsers[0]!.context.pageList as unknown as FakePage[];
      const page = (url: string) => pages.find(item => item.currentUrl === url)!;
      let files: File[] = [];
      fixture.api.listDownloads.mockImplementation(async (_id: string, input?: { includeUrls?: boolean; cursor?: string }) => {
        const pageSize = 2, start = Number(input?.cursor ?? 0);
        const slice = files.slice(start, start + pageSize).map(file => input?.includeUrls ? { ...file, url: `https://files.example/${file.path}?sig=${file.size}` } : { ...file, url: undefined });
        const more = start + pageSize < files.length;
        return { files: slice, hasMore: more, nextCursor: more ? String(start + pageSize) : null };
      });
      const now = new Date().toISOString();
      const setFiles = (next: Array<[string, number]>) => { files = next.map(([path, size]) => ({ path, size, lastModified: now })); };
      return { fixture, first, second, a: a.tab_id, b: b.tab_id, pageA: page("https://example.com/a"), pageB: page("https://example.com/b"), setFiles };
    }

    it("refuses a filename that two threads' tabs downloaded instead of guessing", async () => {
      const { first, second, a, b, pageA, pageB, setFiles } = await twoTabs();
      pageA.emitDownload("report.pdf");
      pageB.emitDownload("report.pdf");
      setFiles([["report.pdf", 10], ["unrelated.txt", 20]]);
      for (const [browser, tab] of [[first, a], [second, b]] as const) {
        const listed = await browser.listDownloads(tab);
        expect(listed.downloads).toEqual([]);
        expect(listed.ambiguous_downloads).toEqual([expect.objectContaining({ filename: "report.pdf" })]);
        await expect(browser.resolveDownload(tab, 0)).rejects.toSatisfy((error: BrowserUseRuntimeError) => error.code === "stale_download");
      }
    });

    it("lists one tab's own downloads, including a repeated name, with indexes stable across relisting and pages", async () => {
      const { first, second, a, b, pageA, pageB, setFiles } = await twoTabs();
      pageA.emitDownload("data.csv");
      pageA.emitDownload("data.csv");
      pageA.emitDownload("chart.png");
      pageB.emitDownload("other.zip");
      // Two listing pages; the provider keeps one object per path.
      setFiles([["other.zip", 5], ["data.csv", 1], ["chart.png", 2]]);
      const listed = await first.listDownloads(a);
      expect(listed.downloads).toEqual([
        expect.objectContaining({ download_index: 0, filename: "data.csv", size: 1 }),
        expect.objectContaining({ download_index: 1, filename: "chart.png", size: 2 }),
      ]);
      expect(listed.ambiguous_downloads).toBeUndefined();
      await expect(second.listDownloads(b)).resolves.toMatchObject({ downloads: [expect.objectContaining({ filename: "other.zip", size: 5 })] });
      // Provider order changes between listings; selected indexes keep their files.
      setFiles([["chart.png", 2], ["other.zip", 5], ["data.csv", 1]]);
      await expect(first.resolveDownload(a, 1)).resolves.toEqual({ url: "https://files.example/chart.png?sig=2", filename: "chart.png" });
      await expect(first.listDownloads(a)).resolves.toMatchObject({ downloads: [
        expect.objectContaining({ download_index: 0, filename: "data.csv" }),
        expect.objectContaining({ download_index: 1, filename: "chart.png" }),
      ] });
      await expect(second.resolveDownload(b, 0)).resolves.toEqual({ url: "https://files.example/other.zip?sig=5", filename: "other.zip" });
    });

    it("refuses a selected download that becomes ambiguous after a late completion or a closed tab", async () => {
      const { fixture, first, second, a, b, pageA, pageB, setFiles } = await twoTabs();
      pageA.emitDownload("invoice.pdf");
      setFiles([["invoice.pdf", 7]]);
      await expect(first.listDownloads(a)).resolves.toMatchObject({ downloads: [expect.objectContaining({ filename: "invoice.pdf" })] });
      // Another thread's tab starts a download with the same name before this one is sent.
      pageB.emitDownload("invoice.pdf");
      await expect(first.resolveDownload(a, 0)).rejects.toSatisfy((error: BrowserUseRuntimeError) => error.code === "ambiguous_download");
      setFiles([["invoice.pdf", 7], ["invoice.pdf", 8]]);
      await expect(second.listDownloads(b)).resolves.toMatchObject({ downloads: [] });
      // Closing the other tab does not make its earlier download ours.
      await second.closeTab(b);
      await expect(first.listDownloads(a)).resolves.toMatchObject({ downloads: [], ambiguous_downloads: [expect.objectContaining({ filename: "invoice.pdf" })] });
      expect(fixture.api.listDownloads).toHaveBeenCalled();
    });

    it("reports a selected download removed from the provider listing as unavailable", async () => {
      const { first, a, pageA, setFiles } = await twoTabs();
      pageA.emitDownload("photo.png");
      setFiles([["photo.png", 3]]);
      await first.listDownloads(a);
      setFiles([]);
      await expect(first.resolveDownload(a, 0)).rejects.toSatisfy((error: BrowserUseRuntimeError) => error.code === "download_unavailable");
    });

    it("reports an expired URL for an owned download", async () => {
      const { fixture, first, a, pageA, setFiles } = await twoTabs();
      pageA.emitDownload("photo.png");
      setFiles([["photo.png", 3]]);
      await first.listDownloads(a);
      fixture.api.listDownloads.mockResolvedValueOnce({ files: [{ path: "photo.png", size: 3, lastModified: new Date().toISOString() }], hasMore: false });
      await expect(first.resolveDownload(a, 0)).rejects.toSatisfy((error: BrowserUseRuntimeError) => error.code === "download_unavailable");
    });
  });

  async function runtimeFixture(
    overrides: Parameters<typeof loadTestConfig>[0] = {},
    storageStateUnavailable = false,
  ) {
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
        browser.context.storageStateUnavailable = storageStateUnavailable;
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
      return activeBrowser(
        `123e4567-e89b-12d3-a456-${String(session).padStart(12, "0")}`,
        input.timeout,
        `https://session-${session}.cdp.browser-use.test`,
      );
    }),
    stopBrowser: vi.fn(async (id: string) => {
      profileRevision += 1;
      return stoppedBrowser(id);
    }),
    listDownloads: vi.fn(async (_sessionId: string, _input?: { includeUrls?: boolean; cursor?: string; limit?: number }): Promise<{
      files: Array<{ path: string; size: number; lastModified: string; url?: string }>; hasMore: boolean; nextCursor?: string | null;
    }> => ({ files: [], hasMore: false })),
  };
}

function activeBrowser(id: string, timeout: number, cdpUrl = "https://session.cdp.browser-use.test") {
  return {
    id,
    status: "active" as const,
    timeoutAt: new Date(Date.now() + timeout * 60_000).toISOString(),
    startedAt: new Date().toISOString(),
    cdpUrl,
  };
}

function stoppedBrowser(id: string) {
  return {
    id,
    status: "stopped" as const,
    timeoutAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    cdpUrl: null,
    proxyUsedMb: "0",
    proxyCost: "0",
  };
}

class FakeBrowser {
  connected = true;
  readonly context = new FakeContext();
  readonly allContexts = [this.context];
  nextOfficeEvaluateGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };

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
    context.nextNewPageEvaluateGate = this.nextOfficeEvaluateGate;
    this.nextOfficeEvaluateGate = undefined;
    this.allContexts.push(context);
    return context as unknown as BrowserContext;
  }
}

class FakeContext {
  readonly pageList = [new FakePage()];
  closed = false;
  storageStateUnavailable = false;
  nextNewPageEvaluateGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };

  pages(): Page[] {
    return this.pageList as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    const page = new FakePage();
    page.nextEvaluateGate = this.nextNewPageEvaluateGate;
    this.nextNewPageEvaluateGate = undefined;
    this.pageList.push(page);
    return page as unknown as Page;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.pageList.map((page) => page.close()));
  }

  async storageState(): Promise<{ cookies: []; origins: [] }> {
    if (this.storageStateUnavailable) throw new Error("storage state unavailable");
    return { cookies: [], origins: [] };
  }
}

class FakePage {
  currentUrl = "about:blank";
  closed = false;
  scroll = { x: 0, y: 0 };
  closeListeners: Array<() => void> = [];
  screenshotBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  lastInjectedHtml?: string;
  lastLocatorSelector?: string;
  locatorScreenshotCount = 0;
  nextGotoGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };
  nextEvaluateGate?: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  };

  async setViewportSize(): Promise<void> {}

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    const gate = this.nextGotoGate;
    this.nextGotoGate = undefined;
    gate?.started.resolve();
    await gate?.release.promise;
    this.currentUrl = url;
  }

  async waitForLoadState(): Promise<void> {}

  async setContent(): Promise<void> {}

  async waitForTimeout(): Promise<void> {}

  async screenshot(): Promise<Buffer> {
    return this.screenshotBytes;
  }

  locator(selector: string) {
    this.lastLocatorSelector = selector;
    const locator = {
      first: () => locator,
      count: async () => 1,
      screenshot: async () => {
        this.locatorScreenshotCount += 1;
        return this.screenshotBytes;
      },
      ariaSnapshot: async () => "Page content",
      innerText: async () => "Page content",
    };
    return locator;
  }

  async title(): Promise<string> {
    return `Title ${this.currentUrl}`;
  }

  downloadListeners: Array<(download: { suggestedFilename(): string }) => void> = [];

  on(event: string, listener: (download: { suggestedFilename(): string }) => void): this {
    if (event === "download") this.downloadListeners.push(listener);
    return this;
  }

  emitDownload(filename: string): void {
    for (const listener of this.downloadListeners) listener({ suggestedFilename: () => filename });
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

  async evaluate<T, Arg = unknown>(expression: string | ((arg: Arg) => T), arg?: Arg): Promise<T> {
    if (typeof expression === "function") {
      const gate = this.nextEvaluateGate;
      this.nextEvaluateGate = undefined;
      gate?.started.resolve();
      await gate?.release.promise;
      if (typeof arg === "string") this.lastInjectedHtml = arg;
      return undefined as T;
    }
    if (expression.includes("window.scrollX")) return this.scroll as T;
    if (expression.includes("data-ai-tg-browser-ref")) return [] as T;
    const match = expression.match(/window\.scrollTo\(([-\d]+), ([-\d]+)\)/);
    if (match) this.scroll = { x: Number(match[1]), y: Number(match[2]) };
    return [] as T;
  }

  async opener(): Promise<Page | null> {
    return null;
  }
}
