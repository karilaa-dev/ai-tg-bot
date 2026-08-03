import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { Logger } from "../logger.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import {
  BrowserUseHttpError,
  createBrowserUseClient,
  redactBrowserUseError,
  type BrowserUseDownload,
  type BrowserUseProfile,
  type BrowserUseSession,
} from "./client.js";

const SCREEN = { width: 2560, height: 1440 } as const;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
const COMPACT_VIEWPORT = { width: 1600, height: 900 } as const;
const SNAPSHOT_CHUNK_CHARS = 12_000;
const MAX_SNAPSHOT_CHARS = 120_000;
const MAX_INTERACTIVE_REFS = 500;
const DEADLINE_MARGIN_MS = 15_000;
const EXTENSION_REQUIRED_MS = 60_000;
const STOP_RETRIES = 3;
const PROFILE_SAVE_TIMEOUT_MS = 5_000;
const PROFILE_SAVE_POLL_MS = 250;
const STORAGE_STATE_TIMEOUT_MS = 2_000;

type BrowserUseRuntimeConfig = Pick<
  AppConfig,
  | "BROWSER_USE_API_KEY"
  | "BROWSER_USE_DEPLOYMENT_ID"
  | "BROWSER_USE_DEFAULT_TIMEOUT_MINUTES"
  | "BROWSER_USE_IDLE_TIMEOUT_MS"
  | "BROWSER_USE_API_TIMEOUT_MS"
  | "BROWSER_USE_NAVIGATION_TIMEOUT_MS"
>;

interface BrowserUseApi {
  listProfiles(query: string, signal?: AbortSignal): Promise<BrowserUseProfile[]>;
  createProfile(input: { name: string; userId: string }, signal?: AbortSignal): Promise<BrowserUseProfile>;
  getProfile(profileId: string, signal?: AbortSignal): Promise<BrowserUseProfile>;
  createBrowser(input: {
    profileId: string;
    proxyCountryCode: null;
    timeout: number;
    browserScreenWidth: number;
    browserScreenHeight: number;
    allowResizing: boolean;
    enableRecording: false;
  }, signal?: AbortSignal): Promise<BrowserUseSession>;
  stopBrowser(sessionId: string, signal?: AbortSignal): Promise<BrowserUseSession>;
  listDownloads(
    sessionId: string,
    input?: { includeUrls?: boolean; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ files: BrowserUseDownload[]; nextCursor?: string | null; hasMore: boolean }>;
}

interface TabState {
  id: string;
  ownerThreadId: number;
  page: Page;
  refs: Map<string, { href?: string }>;
}

interface DownloadHint {
  tabId: string;
  filename: string;
  startedAt: number;
}

interface SessionState {
  id: string;
  profileId: string;
  storageSignature: string | null;
  timeoutAt: number;
  timeoutMinutes: number;
  browser: Browser;
  context: BrowserContext;
  tabs: Map<string, TabState>;
  officeContexts: Map<number, { context: BrowserContext; page: Page }>;
  downloadHints: DownloadHint[];
  downloadSelections: Map<string, string[]>;
}

interface UserState {
  userId: number;
  activeTurns: Map<number, number>;
  lock: AsyncLock;
  profilePromise?: Promise<string>;
  session?: SessionState;
  sessionPromise?: Promise<SessionState>;
  idleTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
}

export class BrowserUseRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserUseRuntimeError";
  }
}

export interface BrowserUseToolRuntime {
  open(url: string, timeoutMinutes?: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  listTabs(signal?: AbortSignal): Promise<Record<string, unknown>>;
  navigate(tabId: string, url: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  snapshot(tabId: string, offset: number, includeScreenshot: boolean, signal?: AbortSignal): Promise<Record<string, unknown>>;
  click(tabId: string, target: { ref?: string; selector?: string; doubleClick?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>>;
  type(tabId: string, target: { ref?: string; selector?: string; text: string; clear?: boolean; submit?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>>;
  press(tabId: string, key: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  scroll(tabId: string, direction: "up" | "down" | "left" | "right", amount: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  screenshot(tabId: string, fullPage: boolean, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType: string; viewport: { width: number; height: number }; session_remaining_seconds: number }>;
  listDownloads(tabId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  sessionRemaining(tabId: string, substantial: boolean, signal?: AbortSignal): Promise<number>;
  resolveDownload(tabId: string, downloadIndex: number, signal?: AbortSignal): Promise<{ url: string; filename: string }>;
  resolveLink(tabId: string, ref: string, signal?: AbortSignal): Promise<string>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  extendSession(timeoutMinutes: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  closeSession(signal?: AbortSignal): Promise<Record<string, unknown>>;
  renderOfficeHtml(html: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType: string; session_remaining_seconds: number }>;
}

export class BrowserUseRuntimeManager {
  private readonly states = new Map<number, UserState>();
  private readonly api: BrowserUseApi;
  private readonly connect: (cdpUrl: string, timeoutMs: number) => Promise<Browser>;
  private proxyViolationDetected = false;

  constructor(private readonly input: {
    config: BrowserUseRuntimeConfig;
    repos: Repos;
    logger?: Logger;
    api?: BrowserUseApi;
    connect?: (cdpUrl: string, timeoutMs: number) => Promise<Browser>;
  }) {
    this.api = input.api ?? createBrowserUseClient(input.config);
    this.connect = input.connect ?? ((cdpUrl, timeoutMs) => chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs }));
  }

  async beginTurn(userId: number, threadId: number): Promise<void> {
    const state = this.state(userId);
    clearTimer(state, "idleTimer");
    state.activeTurns.set(threadId, (state.activeTurns.get(threadId) ?? 0) + 1);
  }

  async endTurn(userId: number, threadId: number): Promise<void> {
    const state = this.states.get(userId);
    if (!state) return;
    const count = state.activeTurns.get(threadId) ?? 0;
    if (count <= 1) state.activeTurns.delete(threadId);
    else state.activeTurns.set(threadId, count - 1);
    await state.lock.run(async () => {
      const office = state.session?.officeContexts.get(threadId);
      if (office) {
        state.session!.officeContexts.delete(threadId);
        await office.context.close().catch(() => undefined);
      }
      this.scheduleCleanup(state);
    });
  }

  forThread(userId: number, threadId: number): BrowserUseToolRuntime {
    return {
      open: (url, timeout, signal) => this.open(userId, threadId, url, timeout, signal),
      listTabs: (signal) => this.listTabs(userId, threadId, signal),
      navigate: (tabId, url, signal) => this.navigate(userId, threadId, tabId, url, signal),
      snapshot: (tabId, offset, includeScreenshot, signal) =>
        this.snapshot(userId, threadId, tabId, offset, includeScreenshot, signal),
      click: (tabId, target, signal) => this.click(userId, threadId, tabId, target, signal),
      type: (tabId, target, signal) => this.type(userId, threadId, tabId, target, signal),
      press: (tabId, key, signal) => this.press(userId, threadId, tabId, key, signal),
      scroll: (tabId, direction, amount, signal) =>
        this.scroll(userId, threadId, tabId, direction, amount, signal),
      screenshot: (tabId, fullPage, signal) => this.screenshot(userId, threadId, tabId, fullPage, signal),
      listDownloads: (tabId, signal) => this.listDownloads(userId, threadId, tabId, signal),
      sessionRemaining: (tabId, substantial, signal) =>
        this.sessionRemaining(userId, threadId, tabId, substantial, signal),
      resolveDownload: (tabId, index, signal) => this.resolveDownload(userId, threadId, tabId, index, signal),
      resolveLink: (tabId, ref, signal) => this.resolveLink(userId, threadId, tabId, ref, signal),
      closeTab: (tabId, signal) => this.closeTab(userId, threadId, tabId, signal),
      extendSession: (timeout, signal) => this.extendSession(userId, threadId, timeout, signal),
      closeSession: (signal) => this.closeSession(userId, threadId, signal),
      renderOfficeHtml: (html, signal) => this.renderOfficeHtml(userId, threadId, html, signal),
    };
  }

  async dispose(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    await Promise.all(states.map((state) => state.lock.run(async () => {
      await this.closeSessionLocked(state, "shutdown").catch((error) => {
        this.input.logger?.warn("Browser Use shutdown cleanup failed", { error: String(error) });
      });
    })));
  }

  private state(userId: number): UserState {
    let state = this.states.get(userId);
    if (!state) {
      const lock = new AsyncLock(() => {
        const current = this.states.get(userId);
        if (
          current?.lock === lock
          && !current.session
          && !current.sessionPromise
          && !current.activeTurns.size
        ) {
          this.states.delete(userId);
        }
      });
      state = { userId, activeTurns: new Map(), lock };
      this.states.set(userId, state);
    }
    return state;
  }

  private async open(
    userId: number,
    threadId: number,
    url: string,
    timeoutMinutes?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.state(userId).lock.run(async () => {
      throwIfAborted(signal);
      const state = this.state(userId);
      const session = await this.ensureSessionLocked(state, timeoutMinutes, signal);
      this.assertTime(session, true);
      const page = await this.availablePage(session);
      const tab = this.registerTab(session, page, threadId);
      try {
        await this.goto(page, url, signal);
      } catch (error) {
        session.tabs.delete(tab.id);
        await page.close().catch(() => undefined);
        throw error;
      }
      return {
        tab_id: tab.id,
        url: page.url(),
        title: await safeTitle(page),
        session_remaining_seconds: remainingSeconds(session),
        ...(timeoutMinutes !== undefined
          ? browserTimeoutRequestResult(session, timeoutMinutes)
          : {}),
      };
    }, signal);
  }

  private async listTabs(userId: number, threadId: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.state(userId).lock.run(async () => {
      const state = this.state(userId);
      const session = state.session;
      if (!session || !session.browser.isConnected()) return { tabs: [], session_remaining_seconds: 0 };
      await this.syncPages(session, threadId);
      const tabs = await Promise.all([...session.tabs.values()]
        .filter((tab) => tab.ownerThreadId === threadId && !tab.page.isClosed())
        .map(async (tab) => ({ tab_id: tab.id, url: tab.page.url(), title: await safeTitle(tab.page) })));
      return { tabs, session_remaining_seconds: remainingSeconds(session) };
    }, signal);
  }

  private async navigate(
    userId: number,
    threadId: number,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      this.assertTime(session, true);
      tab.refs.clear();
      await this.goto(tab.page, url, signal);
      return pageResult(session, tab);
    });
  }

  private async snapshot(
    userId: number,
    threadId: number,
    tabId: string,
    offset: number,
    includeScreenshot: boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      const page = tab.page;
      const refs = await page.evaluate<InteractiveRef[]>(interactiveRefsScript(MAX_INTERACTIVE_REFS));
      tab.refs = new Map(refs.map((ref) => [ref.ref, { href: ref.href }]));
      let semantic = "";
      try {
        semantic = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
      } catch {
        semantic = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
      }
      const refText = refs.map((ref) =>
        `[ref=${ref.ref}] ${ref.role}${ref.name ? ` ${JSON.stringify(ref.name)}` : ""}${ref.href ? ` href=${ref.href}` : ""}`
      ).join("\n");
      const full = [semantic, refText && `Interactive elements:\n${refText}`]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_SNAPSHOT_CHARS);
      const chunk = full.slice(offset, offset + SNAPSHOT_CHUNK_CHARS);
      const nextOffset = offset + chunk.length;
      const output: Record<string, unknown> = {
        tab_id: tab.id,
        url: page.url(),
        snapshot: chunk,
        refs_count: refs.length,
        truncated: full.length >= MAX_SNAPSHOT_CHARS,
        total_chars: full.length,
        has_more: nextOffset < full.length,
        ...(nextOffset < full.length ? { next_offset: nextOffset } : {}),
        session_remaining_seconds: remainingSeconds(session),
      };
      if (includeScreenshot) {
        const screenshot = await page.screenshot({ type: "png", fullPage: false });
        if (screenshot.length <= MAX_FILE_BYTES) {
          output.screenshot_base64 = screenshot.toString("base64");
          output.screenshot_media_type = "image/png";
          output.screenshot_size = screenshot.length;
        }
      }
      return output;
    });
  }

  private async click(
    userId: number,
    threadId: number,
    tabId: string,
    target: { ref?: string; selector?: string; doubleClick?: boolean },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      const locator = targetLocator(tab, target);
      if (target.doubleClick) await locator.dblclick({ timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS });
      else await locator.click({ timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS });
      await this.syncPages(session, threadId);
      return pageResult(session, tab);
    });
  }

  private async type(
    userId: number,
    threadId: number,
    tabId: string,
    target: { ref?: string; selector?: string; text: string; clear?: boolean; submit?: boolean },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      const locator = targetLocator(tab, target);
      if (target.clear ?? true) await locator.fill(target.text, { timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS });
      else await locator.pressSequentially(target.text, { timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS });
      if (target.submit) await locator.press("Enter", { timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS });
      return pageResult(session, tab);
    });
  }

  private async press(
    userId: number,
    threadId: number,
    tabId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      await tab.page.keyboard.press(key);
      return pageResult(session, tab);
    });
  }

  private async scroll(
    userId: number,
    threadId: number,
    tabId: string,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
      await tab.page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
      const position = await tab.page.evaluate<{ x: number; y: number }>("({x: window.scrollX, y: window.scrollY})");
      return { ...await pageResult(session, tab), scroll_x: position.x, scroll_y: position.y };
    });
  }

  private async screenshot(
    userId: number,
    threadId: number,
    tabId: string,
    fullPage: boolean,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mediaType: string; viewport: { width: number; height: number }; session_remaining_seconds: number }> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      this.assertTime(session, fullPage);
      const viewport = await chooseScreenshotViewport(tab.page);
      let bytes = await tab.page.screenshot({ type: "png", fullPage });
      let mediaType = "image/png";
      if (bytes.length > MAX_FILE_BYTES && fullPage) {
        bytes = await tab.page.screenshot({ type: "jpeg", quality: 85, fullPage: true });
        mediaType = "image/jpeg";
      }
      assertImageSize(bytes);
      return { bytes, mediaType, viewport, session_remaining_seconds: remainingSeconds(session) };
    });
  }

  private async listDownloads(
    userId: number,
    threadId: number,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session) => {
      const files = await this.allDownloads(session, false, signal);
      const hints = session.downloadHints.filter((hint) => hint.tabId === tabId);
      const used = new Set<string>();
      const matched = hints.flatMap((hint) => {
        const file = files.find((candidate) => {
          if (used.has(candidate.path) || path.posix.basename(candidate.path) !== hint.filename) return false;
          const modified = Date.parse(candidate.lastModified);
          return !Number.isFinite(modified) || modified >= hint.startedAt - 10_000;
        });
        if (!file) return [];
        used.add(file.path);
        return [file];
      });
      session.downloadSelections.set(tabId, matched.map((file) => file.path));
      return {
        tab_id: tabId,
        downloads: matched.map((file, downloadIndex) => ({
          download_index: downloadIndex,
          filename: path.posix.basename(file.path),
          size: file.size,
          state: "complete",
        })),
        session_remaining_seconds: remainingSeconds(session),
      };
    });
  }

  private async resolveDownload(
    userId: number,
    threadId: number,
    tabId: string,
    downloadIndex: number,
    signal?: AbortSignal,
  ): Promise<{ url: string; filename: string }> {
    return this.withTab(userId, threadId, tabId, signal, async (session) => {
      this.assertTime(session, true);
      const selectedPath = session.downloadSelections.get(tabId)?.[downloadIndex];
      if (!selectedPath) throw new BrowserUseRuntimeError("stale_download", "List browser downloads again before sending this file.");
      const files = await this.allDownloads(session, true, signal);
      const file = files.find((candidate) => candidate.path === selectedPath);
      if (!file?.url) throw new BrowserUseRuntimeError("download_unavailable", "Browser download URL is unavailable or expired.");
      return { url: file.url, filename: path.posix.basename(file.path) };
    });
  }

  private async sessionRemaining(
    userId: number,
    threadId: number,
    tabId: string,
    substantial: boolean,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.withTab(userId, threadId, tabId, signal, async (session) => {
      this.assertTime(session, substantial);
      return remainingSeconds(session);
    });
  }

  private async resolveLink(
    userId: number,
    threadId: number,
    tabId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.withTab(userId, threadId, tabId, signal, async (_session, tab) => {
      const href = tab.refs.get(ref)?.href;
      if (!href) throw new BrowserUseRuntimeError("link_not_found", `Browser link ref ${ref} was not found in the latest snapshot.`);
      return href;
    });
  }

  private async closeTab(
    userId: number,
    threadId: number,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.withTab(userId, threadId, tabId, signal, async (session, tab) => {
      session.tabs.delete(tab.id);
      session.downloadSelections.delete(tab.id);
      await tab.page.close();
      return { closed: true, tab_id: tab.id, session_remaining_seconds: remainingSeconds(session) };
    });
  }

  private async extendSession(
    userId: number,
    threadId: number,
    timeoutMinutes: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const state = this.state(userId);
    return state.lock.run(async () => {
      this.assertNoOtherActiveThread(state, threadId);
      const old = state.session;
      if (!old) {
        const created = await this.ensureSessionLocked(state, timeoutMinutes, signal);
        return {
          extended: true,
          timeout_minutes: timeoutMinutes,
          reopened_tabs: 0,
          session_remaining_seconds: remainingSeconds(created),
        };
      }
      const tabs = await Promise.all([...old.tabs.values()].filter((tab) => !tab.page.isClosed()).map(async (tab) => ({
        id: tab.id,
        ownerThreadId: tab.ownerThreadId,
        url: tab.page.url(),
        scroll: await tab.page.evaluate<{ x: number; y: number }>("({x: window.scrollX, y: window.scrollY})").catch(() => ({ x: 0, y: 0 })),
      })));
      await this.closeSessionLocked(state, "rollover");
      const replacement = await this.ensureSessionLocked(state, timeoutMinutes, signal);
      const failures: Array<{ tab_id: string; error: string }> = [];
      for (const saved of tabs) {
        try {
          const page = await this.availablePage(replacement);
          this.registerTab(replacement, page, saved.ownerThreadId, saved.id);
          if (/^https?:/i.test(saved.url)) await this.goto(page, saved.url, signal);
          if (saved.scroll.x || saved.scroll.y) {
            await page.evaluate(`window.scrollTo(${saved.scroll.x}, ${saved.scroll.y})`);
          }
        } catch (error) {
          replacement.tabs.delete(saved.id);
          failures.push({ tab_id: saved.id, error: String(error) });
        }
      }
      return {
        extended: true,
        timeout_minutes: timeoutMinutes,
        reopened_tabs: tabs.length - failures.length,
        ...(failures.length ? { failed_tabs: failures } : {}),
        warning: "Cookies and persistent storage were preserved, but unsaved forms, sessionStorage, dialogs, and JavaScript state were not.",
        session_remaining_seconds: remainingSeconds(replacement),
      };
    }, signal);
  }

  private async closeSession(
    userId: number,
    threadId: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const state = this.state(userId);
    return state.lock.run(async () => {
      this.assertNoOtherActiveThread(state, threadId);
      if (!state.session) return { closed: false, already_closed: true, profile_preserved: true };
      const tabsClosed = new Set([
        ...[...state.session.tabs.values()].filter((tab) => !tab.page.isClosed()).map((tab) => tab.page),
        ...state.session.context.pages().filter((page) => !page.isClosed()),
      ]).size;
      await this.closeSessionLocked(state, "agent");
      return { closed: true, tabs_closed: tabsClosed, profile_preserved: true };
    }, signal);
  }

  private async renderOfficeHtml(
    userId: number,
    threadId: number,
    html: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mediaType: string; session_remaining_seconds: number }> {
    const state = this.state(userId);
    return state.lock.run(async () => {
      const session = await this.ensureSessionLocked(state, undefined, signal);
      this.assertTime(session, true);
      let office = session.officeContexts.get(threadId);
      if (!office) {
        const context = await session.browser.newContext({ viewport: { width: 1600, height: 1200 } });
        office = { context, page: await context.newPage() };
        session.officeContexts.set(threadId, office);
      }
      await office.page.setContent(html, {
        waitUntil: "load",
        timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS,
      });
      await office.page.evaluate("document.fonts?.ready").catch(() => undefined);
      await office.page.waitForTimeout(250);
      const bytes = await office.page.screenshot({ type: "png", fullPage: true });
      assertImageSize(bytes);
      return { bytes, mediaType: "image/png", session_remaining_seconds: remainingSeconds(session) };
    }, signal);
  }

  private async withTab<T>(
    userId: number,
    threadId: number,
    tabId: string,
    signal: AbortSignal | undefined,
    operation: (session: SessionState, tab: TabState) => Promise<T>,
  ): Promise<T> {
    const state = this.state(userId);
    return state.lock.run(async () => {
      throwIfAborted(signal);
      const session = state.session;
      if (!session || !session.browser.isConnected()) {
        throw new BrowserUseRuntimeError("browser_session_closed", "The browser session is closed. Open a new browser tab.");
      }
      const tab = session.tabs.get(tabId);
      if (!tab || tab.ownerThreadId !== threadId || tab.page.isClosed()) {
        throw new BrowserUseRuntimeError("tab_not_found", `Browser tab ${tabId} is not available in this thread.`);
      }
      return operation(session, tab);
    }, signal);
  }

  private async ensureSessionLocked(
    state: UserState,
    requestedTimeout: number | undefined,
    signal?: AbortSignal,
  ): Promise<SessionState> {
    if (this.proxyViolationDetected) {
      throw new BrowserUseRuntimeError(
        "proxy_detected",
        "Browser Use reported proxy usage even though proxies were disabled. New browser sessions are blocked until the bot restarts.",
      );
    }
    if (state.session?.browser.isConnected() && state.session.timeoutAt > Date.now() + DEADLINE_MARGIN_MS) {
      return state.session;
    }
    if (state.session) await this.closeSessionLocked(state, "expired").catch(() => undefined);
    if (state.sessionPromise) return state.sessionPromise;
    const timeoutMinutes = clampTimeout(
      requestedTimeout ?? this.input.config.BROWSER_USE_DEFAULT_TIMEOUT_MINUTES,
    );
    state.sessionPromise = (async () => {
      const profileId = await this.ensureProfile(state, signal);
      const remote = await this.api.createBrowser({
        profileId,
        proxyCountryCode: null,
        timeout: timeoutMinutes,
        browserScreenWidth: SCREEN.width,
        browserScreenHeight: SCREEN.height,
        allowResizing: true,
        enableRecording: false,
      }, signal);
      if (this.recordProxyViolation(remote, "create")) {
        await this.stopRemote(remote.id).catch(() => undefined);
        throw new BrowserUseRuntimeError(
          "proxy_detected",
          "Browser Use assigned proxy usage to a no-proxy browser session. The session was stopped.",
        );
      }
      if (!remote.cdpUrl) {
        await this.stopRemote(remote.id).catch(() => undefined);
        throw new Error("Browser Use Cloud did not return a CDP URL.");
      }
      let browser: Browser;
      try {
        browser = await this.connect(remote.cdpUrl, this.input.config.BROWSER_USE_API_TIMEOUT_MS);
      } catch (error) {
        await this.stopRemote(remote.id).catch(() => undefined);
        throw error;
      }
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        await this.stopRemote(remote.id).catch(() => undefined);
        throw new Error("Browser Use Cloud did not provide a profile browser context.");
      }
      const timeoutAt = Date.parse(remote.timeoutAt);
      const session: SessionState = {
        id: remote.id,
        profileId,
        storageSignature: await browserStorageSignature(context),
        timeoutAt: Number.isFinite(timeoutAt) ? timeoutAt : Date.now() + timeoutMinutes * 60_000,
        timeoutMinutes,
        browser,
        context,
        tabs: new Map(),
        officeContexts: new Map(),
        downloadHints: [],
        downloadSelections: new Map(),
      };
      state.session = session;
      this.scheduleCleanup(state);
      this.input.logger?.info("Browser Use session ready", {
        userId: state.userId,
        timeoutMinutes,
      });
      return session;
    })();
    try {
      return await state.sessionPromise;
    } finally {
      state.sessionPromise = undefined;
    }
  }

  private async ensureProfile(state: UserState, signal?: AbortSignal): Promise<string> {
    const pending = state.profilePromise ??= (async () => {
      const row = await this.input.repos.browserUseProfiles.ensure(
        this.input.config.BROWSER_USE_DEPLOYMENT_ID,
        state.userId,
      );
      if (row.profile_id) {
        try {
          await this.api.getProfile(row.profile_id, signal);
          return row.profile_id;
        } catch (error) {
          if (!(error instanceof BrowserUseHttpError) || error.status !== 404) throw error;
        }
      }
      const matches = await this.api.listProfiles(row.provider_user_key, signal);
      const exact = matches.find((profile) => profile.userId === row.provider_user_key);
      const profile = exact ?? await this.api.createProfile({
        userId: row.provider_user_key,
        name: `${this.input.config.BROWSER_USE_DEPLOYMENT_ID}-${row.provider_user_key.slice(0, 12)}`.slice(0, 100),
      }, signal);
      await this.input.repos.browserUseProfiles.setProfileId(
        this.input.config.BROWSER_USE_DEPLOYMENT_ID,
        state.userId,
        profile.id,
      );
      return profile.id;
    })();
    try {
      return await pending;
    } finally {
      if (state.profilePromise === pending) state.profilePromise = undefined;
    }
  }

  private async availablePage(session: SessionState): Promise<Page> {
    const owned = new Set([...session.tabs.values()].map((tab) => tab.page));
    const spare = session.context.pages().find((page) => !owned.has(page) && page.url() === "about:blank");
    const page = spare ?? await session.context.newPage();
    await page.setViewportSize(DEFAULT_VIEWPORT);
    return page;
  }

  private registerTab(session: SessionState, page: Page, ownerThreadId: number, id: string = randomUUID()): TabState {
    const tab: TabState = { id, ownerThreadId, page, refs: new Map() };
    session.tabs.set(id, tab);
    page.on("download", (download) => {
      session.downloadHints.push({ tabId: id, filename: download.suggestedFilename(), startedAt: Date.now() });
    });
    page.once("close", () => {
      if (session.tabs.get(id)?.page === page) session.tabs.delete(id);
    });
    return tab;
  }

  private async syncPages(session: SessionState, defaultThreadId: number): Promise<void> {
    const known = new Set([...session.tabs.values()].map((tab) => tab.page));
    for (const page of session.context.pages()) {
      if (known.has(page) || page.isClosed() || page.url() === "about:blank") continue;
      const opener = await page.opener().catch(() => null);
      const owner = [...session.tabs.values()].find((tab) => tab.page === opener)?.ownerThreadId ?? defaultThreadId;
      this.registerTab(session, page, owner);
    }
  }

  private async goto(page: Page, url: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.input.config.BROWSER_USE_NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
  }

  private assertTime(session: SessionState, substantial: boolean): void {
    if (substantial && session.timeoutAt - Date.now() < EXTENSION_REQUIRED_MS) {
      throw new BrowserUseRuntimeError(
        "extension_required",
        "Less than 60 seconds remain in this browser session. Extend it before continuing.",
      );
    }
  }

  private assertNoOtherActiveThread(state: UserState, threadId: number): void {
    if ([...state.activeTurns.keys()].some((activeThreadId) => activeThreadId !== threadId)) {
      throw new BrowserUseRuntimeError(
        "session_busy",
        "Another thread is actively using this user's browser session.",
      );
    }
  }

  private scheduleCleanup(state: UserState): void {
    clearTimer(state, "idleTimer");
    clearTimer(state, "deadlineTimer");
    const session = state.session;
    if (!session) return;
    const deadlineDelay = Math.max(0, session.timeoutAt - Date.now() - DEADLINE_MARGIN_MS);
    state.deadlineTimer = setTimeout(() => void this.autoClose(state, "deadline"), deadlineDelay);
    state.deadlineTimer.unref?.();
    if (!state.activeTurns.size) {
      const idleDelay = Math.max(0, Math.min(this.input.config.BROWSER_USE_IDLE_TIMEOUT_MS, deadlineDelay));
      state.idleTimer = setTimeout(() => void this.autoClose(state, "idle"), idleDelay);
      state.idleTimer.unref?.();
    }
  }

  private async autoClose(state: UserState, reason: string): Promise<void> {
    await state.lock.run(async () => {
      if (reason === "idle" && state.activeTurns.size) {
        this.scheduleCleanup(state);
        return;
      }
      await this.closeSessionLocked(state, reason);
    }).catch((error) => {
      this.input.logger?.warn("Browser Use automatic cleanup failed", {
        userId: state.userId,
        reason,
        error: String(error),
      });
    });
  }

  private async closeSessionLocked(state: UserState, reason: string): Promise<void> {
    clearTimer(state, "idleTimer");
    clearTimer(state, "deadlineTimer");
    const session = state.session;
    state.session = undefined;
    if (!session) return;
    const finalStorageSignature = await browserStorageSignature(session.context);
    // An unavailable initial or final snapshot means the storage state is unknown,
    // not unchanged. Wait for the provider's profile-save signal in that case so
    // cookies acquired during the session are not discarded on disconnect.
    const storageChanged = session.storageSignature === null
      || finalStorageSignature === null
      || finalStorageSignature !== session.storageSignature;
    for (const office of session.officeContexts.values()) await office.context.close().catch(() => undefined);
    session.officeContexts.clear();
    const pages = new Set([...session.tabs.values()].map((tab) => tab.page));
    for (const page of session.context.pages()) pages.add(page);
    for (const tab of session.tabs.values()) tab.refs.clear();
    for (const page of pages) await page.close().catch(() => undefined);
    session.tabs.clear();
    session.downloadHints.length = 0;
    session.downloadSelections.clear();
    const profileBefore = storageChanged
      ? await this.api.getProfile(session.profileId).catch(() => undefined)
      : undefined;
    let stopError: unknown;
    try {
      await this.stopRemote(session.id);
      if (profileBefore?.updatedAt) {
        const saved = await this.waitForProfileSave(session.profileId, profileBefore);
        if (!saved) this.input.logger?.warn("Browser Use profile save was not confirmed before disconnect", {
          userId: state.userId,
          reason,
        });
      } else if (storageChanged) {
        // Browser Use persists profile state asynchronously after stop. Keep CDP connected
        // briefly if the profile metadata cannot be polled, or the just-stopped browser can
        // discard the state before the provider finishes saving it.
        await delay(PROFILE_SAVE_TIMEOUT_MS);
      }
    } catch (error) {
      stopError = error;
    } finally {
      await session.browser.close().catch(() => undefined);
    }
    if (stopError) throw stopError;
    this.input.logger?.info("Browser Use session stopped", { userId: state.userId, reason });
  }

  private async waitForProfileSave(profileId: string, before: BrowserUseProfile): Promise<boolean> {
    const beforeSignature = profileSaveSignature(before);
    const deadline = Date.now() + PROFILE_SAVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = await this.api.getProfile(profileId).catch(() => undefined);
      if (current && profileSaveSignature(current) !== beforeSignature) return true;
      await delay(PROFILE_SAVE_POLL_MS);
    }
    return false;
  }

  private async stopRemote(sessionId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= STOP_RETRIES; attempt += 1) {
      try {
        const stopped = await this.api.stopBrowser(sessionId, AbortSignal.timeout(5_000));
        this.recordProxyViolation(stopped, "stop");
        return;
      } catch (error) {
        if (error instanceof BrowserUseHttpError && error.status === 404) return;
        lastError = error;
        if (error instanceof BrowserUseHttpError && error.status < 500 && error.status !== 429) break;
      }
    }
    throw redactBrowserUseError(this.input.config, lastError);
  }

  private recordProxyViolation(session: BrowserUseSession, phase: "create" | "stop"): boolean {
    const usedMb = Number(session.proxyUsedMb ?? 0);
    const cost = Number(session.proxyCost ?? 0);
    if (Number.isFinite(usedMb) && usedMb <= 0 && Number.isFinite(cost) && cost <= 0) return false;
    this.proxyViolationDetected = true;
    this.input.logger?.error("Browser Use no-proxy invariant violated", {
      phase,
      proxyUsedMb: Number.isFinite(usedMb) ? usedMb : "reported",
      proxyCost: Number.isFinite(cost) ? cost : "reported",
    });
    return true;
  }

  private async allDownloads(session: SessionState, includeUrls: boolean, signal?: AbortSignal): Promise<BrowserUseDownload[]> {
    const files: BrowserUseDownload[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const response = await this.api.listDownloads(session.id, { includeUrls, cursor, limit: 100 }, signal);
      files.push(...response.files);
      if (!response.hasMore || !response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return files;
  }
}

interface InteractiveRef {
  ref: string;
  role: string;
  name: string;
  href?: string;
}

function interactiveRefsScript(limit: number): string {
  return `(() => {
    const marker = "data-ai-tg-browser-ref";
    document.querySelectorAll("[" + marker + "]").forEach((element) => element.removeAttribute(marker));
    const selector = ["a[href]", "button", "input", "select", "textarea", "[contenteditable=true]", "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[tabindex]"] .join(",");
    const visible = Array.from(document.querySelectorAll(selector)).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }).slice(0, ${limit});
    return visible.map((element, index) => {
      const ref = "e" + (index + 1);
      element.setAttribute(marker, ref);
      const role = element.getAttribute("role") || ({A:"link",BUTTON:"button",INPUT:"input",SELECT:"select",TEXTAREA:"textarea"}[element.tagName] || element.tagName.toLowerCase());
      const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.value || "";
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;
      return {ref, role, name: String(label).trim().replace(/\\s+/g, " ").slice(0, 300), ...(href ? {href} : {})};
    });
  })()`;
}

function targetLocator(tab: TabState, target: { ref?: string; selector?: string }) {
  if (target.ref) {
    if (!tab.refs.has(target.ref)) {
      throw new BrowserUseRuntimeError("stale_ref", `Browser ref ${target.ref} is stale. Take a new snapshot.`);
    }
    return tab.page.locator(`[data-ai-tg-browser-ref="${target.ref}"]`).first();
  }
  return tab.page.locator(target.selector!).first();
}

async function pageResult(session: SessionState, tab: TabState): Promise<Record<string, unknown>> {
  return {
    tab_id: tab.id,
    url: tab.page.url(),
    title: await safeTitle(tab.page),
    session_remaining_seconds: remainingSeconds(session),
  };
}

async function safeTitle(page: Page): Promise<string> {
  return page.title().catch(() => "");
}

function remainingSeconds(session: SessionState): number {
  return Math.max(0, Math.floor((session.timeoutAt - Date.now()) / 1000));
}

function clampTimeout(value: number): number {
  return Math.max(5, Math.min(240, Math.trunc(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Browser operation was aborted.");
}

function clearTimer(state: UserState, key: "idleTimer" | "deadlineTimer"): void {
  const timer = state[key];
  if (timer) clearTimeout(timer);
  state[key] = undefined;
}

async function chooseScreenshotViewport(page: Page): Promise<{ width: number; height: number }> {
  await page.setViewportSize(DEFAULT_VIEWPORT);
  await page.waitForTimeout(100);
  const measured = await page.evaluate<{ scrollWidth: number; contentWidth: number }>(`(() => {
    const root = document.documentElement;
    const main = document.querySelector("main, [role=main]");
    const elements = main ? [main] : Array.from(document.body?.children || []);
    const rects = elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    const left = rects.length ? Math.min(...rects.map((rect) => rect.left)) : 0;
    const right = rects.length ? Math.max(...rects.map((rect) => rect.right)) : window.innerWidth;
    return {scrollWidth: root.scrollWidth, contentWidth: Math.max(0, right - left)};
  })()`);
  if (measured.scrollWidth > DEFAULT_VIEWPORT.width + 8) {
    await page.setViewportSize(SCREEN);
    return SCREEN;
  }
  if (measured.contentWidth < DEFAULT_VIEWPORT.width * 0.65) {
    await page.setViewportSize(COMPACT_VIEWPORT);
    const compactOverflow = await page.evaluate<number>("document.documentElement.scrollWidth - window.innerWidth");
    if (compactOverflow <= 8) return COMPACT_VIEWPORT;
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
  return DEFAULT_VIEWPORT;
}

function assertImageSize(bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Browser screenshot is too large to attach.");
}

function profileSaveSignature(profile: BrowserUseProfile): string {
  return JSON.stringify({
    updatedAt: profile.updatedAt ?? null,
    lastUsedAt: profile.lastUsedAt ?? null,
    cookieDomains: profile.cookieDomains ?? null,
  });
}

function browserTimeoutRequestResult(
  session: SessionState,
  requestedTimeoutMinutes: number,
): Record<string, unknown> {
  const requested = clampTimeout(requestedTimeoutMinutes);
  const applied = session.timeoutAt >= Date.now() + requested * 60_000 - DEADLINE_MARGIN_MS;
  return {
    requested_timeout_minutes: requested,
    timeout_request_applied: applied,
    effective_session_timeout_minutes: session.timeoutMinutes,
    ...(!applied
      ? {
          extension_required: true,
          extension_hint: "Call browser_extend_session to roll the existing session over to the requested duration.",
        }
      : {}),
  };
}

async function browserStorageSignature(context: BrowserContext): Promise<string | null> {
  if (typeof context.storageState !== "function") return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), STORAGE_STATE_TIMEOUT_MS);
    timer.unref?.();
  });
  const state = await Promise.race([
    context.storageState({ indexedDB: true }).catch(() => undefined),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return state ? createHash("sha256").update(JSON.stringify(state)).digest("hex") : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  private pending = 0;

  constructor(private readonly onIdle?: () => void) {}

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pending += 1;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => current, () => current);
    await previous;
    try {
      throwIfAborted(signal);
      return await operation();
    } finally {
      release();
      this.pending -= 1;
      if (this.pending === 0) this.onIdle?.();
    }
  }
}
