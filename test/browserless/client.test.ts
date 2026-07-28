import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const playwright = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: { connect: playwright.connect },
}));

import { checkBrowserless, renderOfficeHtml } from "../../src/browserless/client.js";
import { loadTestConfig } from "../../src/config.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("Browserless client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks a tokenless Playwright WebSocket endpoint and closes the session", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    playwright.connect.mockResolvedValue({ close });
    const config = loadTestConfig({
      BROWSERLESS_URL: "ws://browserless:3000/chromium/playwright?blockAds=true",
    });

    await checkBrowserless(config);

    expect(playwright.connect).toHaveBeenCalledWith(
      "ws://browserless:3000/chromium/playwright?blockAds=true",
      { timeout: 5_000 },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders HTML with JavaScript disabled, blocks remote resources, and closes the session", async () => {
    let routeHandler: ((route: FakeRoute) => Promise<void>) | undefined;
    const page = {
      setContent: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(PNG),
    };
    const context = {
      route: vi.fn().mockImplementation(async (_pattern, handler) => {
        routeHandler = handler;
      }),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    playwright.connect.mockResolvedValue(browser);
    const config = loadTestConfig({
      BROWSERLESS_URL: "wss://browserless.example/chromium/playwright",
      BROWSERLESS_TOKEN: "secret token",
      BROWSERLESS_TIMEOUT_MS: 12_345,
    });

    const result = await renderOfficeHtml(config, "<!doctype html><html><body>slide</body></html>");

    expect(result).toEqual({ bytes: PNG, mediaType: "image/png" });
    expect(playwright.connect).toHaveBeenCalledWith(
      "wss://browserless.example/chromium/playwright?token=secret+token",
      { timeout: 12_345 },
    );
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1440, height: 1080 },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    expect(page.setContent).toHaveBeenCalledWith(expect.stringContaining("<html>"), {
      waitUntil: "load",
      timeout: 12_345,
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(250);
    expect(page.screenshot).toHaveBeenCalledWith({
      type: "png",
      fullPage: true,
      animations: "disabled",
      timeout: 12_345,
    });

    const allowed = fakeRoute("data:image/png;base64,AA==");
    await routeHandler!(allowed);
    expect(allowed.continue).toHaveBeenCalledTimes(1);
    const blocked = fakeRoute("https://tracker.example/pixel");
    await routeHandler!(blocked);
    expect(blocked.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("closes failed WebSocket renders and redacts the URL and token", async () => {
    const config = loadTestConfig({
      BROWSERLESS_URL: "WSS://BROWSERLESS.EXAMPLE:443/chromium/playwright?label=hello%20world",
      BROWSERLESS_TOKEN: "top secret",
    });
    const context = {
      route: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue({
        setContent: vi.fn().mockRejectedValue(new Error(
          "failed at wss://browserless.example/chromium/playwright?label=hello+world&token=top+secret",
        )),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    playwright.connect.mockResolvedValue(browser);

    const error = await renderOfficeHtml(config, "<html></html>").catch((failure: unknown) => failure);

    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain("browserless.example");
    expect(String(error)).not.toContain("top secret");
    expect(String(error)).not.toContain("top+secret");
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("applies the configured timeout to context creation and still closes the browser", async () => {
    const browser = {
      newContext: vi.fn().mockReturnValue(new Promise(() => undefined)),
      close: vi.fn().mockResolvedValue(undefined),
    };
    playwright.connect.mockResolvedValue(browser);
    const config = loadTestConfig({
      BROWSERLESS_URL: "ws://browserless:3000/chromium/playwright",
      BROWSERLESS_TIMEOUT_MS: 10,
    });

    await expect(renderOfficeHtml(config, "<html></html>")).rejects.toThrow(/timeout/i);

    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("uses the REST health and screenshot APIs with an optional token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(PNG.length) },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadTestConfig({
      BROWSERLESS_URL: "https://browserless.example/base",
      BROWSERLESS_TOKEN: "rest-secret",
    });

    await checkBrowserless(config);
    const result = await renderOfficeHtml(config, "<html><body>report</body></html>");

    expect(result).toEqual({ bytes: PNG, mediaType: "image/png" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://browserless.example/base/active?token=rest-secret");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://browserless.example/base/screenshot?token=rest-secret");
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(request.body))).toEqual({
      html: "<html><body>report</body></html>",
      options: { fullPage: true, type: "png" },
      rejectRequestPattern: ["/^https?:/i", "/^wss?:/i", "/^ftp:/i", "/^file:/i"],
      waitForTimeout: 250,
    });
  });

  it("rejects oversized and non-image REST responses", async () => {
    const config = loadTestConfig({ BROWSERLESS_URL: "http://browserless:3000" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(PNG), {
      status: 200,
      headers: { "content-length": String(20 * 1024 * 1024 + 1) },
    })));
    await expect(renderOfficeHtml(config, "<html></html>")).rejects.toThrow("too large");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not an image", { status: 200 })));
    await expect(renderOfficeHtml(config, "<html></html>")).rejects.toThrow("unsupported image format");
  });
});

interface FakeRoute {
  request(): { url(): string };
  continue: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function fakeRoute(url: string): FakeRoute {
  return {
    request: () => ({ url: () => url }),
    continue: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}
