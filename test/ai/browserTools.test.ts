import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserUseRuntimeError } from "../../src/browserUse/runtime.js";
import { loadTestConfig } from "../../src/config.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";

const browserDownload = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock("../../src/browserUse/download.js", () => ({
  downloadPublicBrowserFile: browserDownload.download,
}));

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

const BROWSER_TOOLS = [
  "browser_open",
  "browser_list_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_screenshot",
  "browser_list_downloads",
  "browser_send_file",
  "browser_close_tab",
  "browser_extend_session",
  "browser_close_session",
] as const;

describe("Browser Use Pi tools", () => {
  afterEach(() => browserDownload.download.mockReset());

  it("registers only when configured and makes every browser tool sequential", () => {
    const disabled = createPiToolAdapters(bridge(loadTestConfig()));
    expect(disabled.some((tool) => tool.name.startsWith("browser_"))).toBe(false);
    expect(disabled.some((tool) => tool.name === "render_office_preview")).toBe(false);
    expect(disabled.find((tool) => tool.name === "inspect_workspace_images")?.executionMode).toBe("sequential");

    const enabled = createPiToolAdapters(bridge(browserConfig(), fakeBrowserRuntime()));
    expect(BROWSER_TOOLS.every((name) => enabled.find((tool) => tool.name === name)?.executionMode === "sequential"))
      .toBe(true);
    expect(enabled.find((tool) => tool.name === "render_office_preview")?.executionMode).toBe("sequential");
    const openDescription = enabled.find((tool) => tool.name === "browser_open")?.description ?? "";
    expect(openDescription).toContain("configured default session duration");
    expect(openDescription).not.toContain("five-minute");
  });

  it("closes the whole session through the model-facing tool", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const close = createPiToolAdapters(bridge(browserConfig(), browserRuntime))
      .find((tool) => tool.name === "browser_close_session")!;

    const result = await close.execute("close", {}, undefined, undefined, {} as never);

    expect(browserRuntime.closeSession).toHaveBeenCalledTimes(1);
    expect(result.details).toEqual({ closed: true, tabs_closed: 3, profile_preserved: true });
  });

  it("returns session_busy without retrying when another thread is active", async () => {
    const browserRuntime = fakeBrowserRuntime();
    browserRuntime.closeSession.mockRejectedValueOnce(
      new BrowserUseRuntimeError("session_busy", "Another thread is actively using this user's browser session."),
    );
    const close = createPiToolAdapters(bridge(browserConfig(), browserRuntime))
      .find((tool) => tool.name === "browser_close_session")!;

    const result = await close.execute("close", {}, undefined, undefined, {} as never);

    expect(result.details).toEqual({
      error: "session_busy",
      message: "Another thread is actively using this user's browser session.",
    });
    expect(browserRuntime.closeSession).toHaveBeenCalledTimes(1);
  });

  it("redacts provider credentials and browser connection URLs from cleanup errors", async () => {
    const browserRuntime = fakeBrowserRuntime();
    browserRuntime.closeSession.mockRejectedValueOnce(
      new Error("secret https://private.cdp.browser-use.test?token=visible"),
    );
    const close = createPiToolAdapters(bridge(browserConfig(), browserRuntime))
      .find((tool) => tool.name === "browser_close_session")!;

    const result = await close.execute("close", {}, undefined, undefined, {} as never);
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private.cdp");
    expect(serialized).toContain("redacted");
  });

  it("propagates cancellation instead of returning a browser tool error", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const reason = new DOMException("cancelled by user", "AbortError");
    browserRuntime.closeSession.mockImplementationOnce(async (signal?: AbortSignal) => {
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { closed: true, tabs_closed: 0, profile_preserved: true };
    });
    const close = createPiToolAdapters(bridge(browserConfig(), browserRuntime))
      .find((tool) => tool.name === "browser_close_session")!;
    const controller = new AbortController();
    const pending = close.execute("close", {}, controller.signal, undefined, {} as never);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("attaches browser screenshots directly without an E2B runtime", async () => {
    const browserRuntime = fakeBrowserRuntime();
    browserRuntime.screenshot.mockResolvedValue({
      bytes: PNG,
      mediaType: "image/png",
      viewport: { width: 1920, height: 1080 },
      session_remaining_seconds: 245,
    });
    const createdFiles: unknown[] = [];
    const selectContextFiles = vi.fn();
    const stored = {
      id: 71,
      type: "image",
      name: "browser-screenshot.png",
      mime_type: "image/png",
      size: PNG.length,
      is_inline: 1,
    };
    const tools = createPiToolAdapters(bridge(browserConfig(), browserRuntime, {
      createdFiles,
      selectContextFiles,
      repos: {
        files: {
          insertFile: vi.fn(async (value: Record<string, unknown>) => ({ ...stored, ...value, id: stored.id })),
          get: vi.fn(async () => stored),
        },
      },
    }));
    const screenshot = tools.find((tool) => tool.name === "browser_screenshot")!;

    const result = await screenshot.execute(
      "screenshot",
      { tab_id: "tab-1", full_page: false, delivery: "photo", caption: "Page" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      attached: true,
      file_id: 71,
      full_page: false,
      delivery: "photo",
      viewport: { width: 1920, height: 1080 },
      session_remaining_seconds: 245,
    });
    expect(result.details).not.toHaveProperty("screenshot_base64");
    expect(createdFiles[0]).toMatchObject({ data: PNG, delivery: "photo", caption: "Page" });
    expect(selectContextFiles).toHaveBeenCalledWith([71]);
  });

  it("attaches Browser Use downloads directly and reports session time", async () => {
    const browserRuntime = fakeBrowserRuntime();
    browserRuntime.sessionRemaining.mockResolvedValue(230);
    browserRuntime.resolveDownload.mockResolvedValue({
      url: "https://93.184.216.34/report.zip",
      filename: "report.zip",
    });
    browserDownload.download.mockResolvedValue({
      bytes: Buffer.from("zip-data"),
      mimeType: "application/zip",
      finalUrl: "https://93.184.216.34/report.zip",
    });
    const createdFiles: unknown[] = [];
    const tools = createPiToolAdapters(bridge(browserConfig(), browserRuntime, {
      createdFiles,
      repos: {
        files: {
          insertFile: vi.fn(async (value: Record<string, unknown>) => ({
            ...value,
            id: 72,
            mime_type: value.mimeType,
            is_inline: 0,
          })),
        },
      },
    }));
    const sendFile = tools.find((tool) => tool.name === "browser_send_file")!;

    const result = await sendFile.execute(
      "download",
      { tab_id: "tab-1", download_index: 0, delivery: "auto" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      attached: true,
      file_id: 72,
      name: "report.zip",
      session_remaining_seconds: 230,
    });
    expect(createdFiles[0]).toMatchObject({ data: Buffer.from("zip-data"), delivery: "document" });
    expect(browserRuntime.sessionRemaining).toHaveBeenCalledWith("tab-1", true, undefined);
    expect(browserDownload.download).toHaveBeenCalledWith(
      "https://93.184.216.34/report.zip",
      30_000,
      undefined,
    );
  });
});

function browserConfig() {
  return loadTestConfig({ BROWSER_USE_API_KEY: "secret" });
}

function bridge(
  config: ReturnType<typeof loadTestConfig>,
  browserRuntime?: ReturnType<typeof fakeBrowserRuntime>,
  extra: Record<string, unknown> = {},
) {
  return {
    buildInput: () => ({
      config,
      repos: {},
      user: { tg_id: 9910 },
      thread: { id: 44 },
      browserRuntime,
      ...extra,
    } as never),
  };
}

function fakeBrowserRuntime() {
  return {
    open: vi.fn(),
    listTabs: vi.fn(),
    navigate: vi.fn(),
    snapshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    press: vi.fn(),
    scroll: vi.fn(),
    screenshot: vi.fn(),
    listDownloads: vi.fn(),
    sessionRemaining: vi.fn(),
    resolveDownload: vi.fn(),
    resolveLink: vi.fn(),
    closeTab: vi.fn(),
    extendSession: vi.fn(),
    closeSession: vi.fn(async (_signal?: AbortSignal) => ({ closed: true, tabs_closed: 3, profile_preserved: true })),
    renderOfficeHtml: vi.fn(),
  };
}
