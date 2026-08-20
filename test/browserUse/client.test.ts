import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserUseClient } from "../../src/browserUse/client.js";
import { loadTestConfig } from "../../src/config.js";

const SESSION = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  status: "active",
  timeoutAt: "2026-08-02T02:00:00.000Z",
  startedAt: "2026-08-02T01:55:00.000Z",
  cdpUrl: "https://secret.cdp.browser-use.com",
  liveUrl: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("BrowserUseClient", () => {
  it("creates profile-backed browsers with proxy and recording explicitly disabled", async () => {
    const request = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(SESSION, 201),
    );
    vi.stubGlobal("fetch", request);
    const client = createBrowserUseClient(loadTestConfig({ BROWSER_USE_API_KEY: "temporary-secret" }));

    await client.createBrowser({
      profileId: "123e4567-e89b-12d3-a456-426614174001",
      proxyCountryCode: null,
      timeout: 5,
      browserScreenWidth: 2560,
      browserScreenHeight: 1440,
      allowResizing: true,
      enableRecording: false,
    });

    const [url, requestInit] = request.mock.calls[0]!;
    const init = requestInit!;
    expect(String(url)).toBe("https://api.browser-use.com/api/v3/browsers");
    expect(init.headers).toMatchObject({
      "X-Browser-Use-API-Key": "temporary-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      profileId: "123e4567-e89b-12d3-a456-426614174001",
      timeout: 5,
      browserScreenWidth: 2560,
      browserScreenHeight: 1440,
      allowResizing: true,
      proxyCountryCode: null,
      enableRecording: false,
    });
  });

  it("stops browsers through the provider update endpoint", async () => {
    const request = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ ...SESSION, status: "stopped" }),
    );
    vi.stubGlobal("fetch", request);
    const client = createBrowserUseClient(loadTestConfig({ BROWSER_USE_API_KEY: "secret" }));

    await client.stopBrowser(SESSION.id);

    const [url, requestInit] = request.mock.calls[0]!;
    const init = requestInit!;
    expect(String(url)).toBe(`https://api.browser-use.com/api/v3/browsers/${SESSION.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ action: "stop" });
  });

  it("cancels a successful profile-deletion response body", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      cancel: cancelled,
    }))));
    const client = createBrowserUseClient(loadTestConfig({ BROWSER_USE_API_KEY: "secret" }));

    await client.deleteProfile("123e4567-e89b-12d3-a456-426614174001");

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("redacts API and browser connection credentials from errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      detail: "secret https://abc.cdp.browser-use.com?token=visible",
    }), { status: 500, headers: { "content-type": "application/json" } })));
    const client = createBrowserUseClient(loadTestConfig({ BROWSER_USE_API_KEY: "secret" }));

    await expect(client.listActiveBrowsers()).rejects.toSatisfy((error: Error) => {
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("abc.cdp");
      return true;
    });
  });

  it("does not expose provider-controlled error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      detail: "Bearer remote-token https://downloads.example/file?X-Amz-Signature=signed-secret",
    }), { status: 502, headers: { "content-type": "application/json" } })));
    const client = createBrowserUseClient(loadTestConfig({ BROWSER_USE_API_KEY: "secret" }));

    await expect(client.listActiveBrowsers()).rejects.toSatisfy((error: Error) => {
      expect(error.message).toBe("Browser Use Cloud HTTP 502.");
      expect(error.message).not.toContain("remote-token");
      expect(error.message).not.toContain("signed-secret");
      return true;
    });
  });

  it("preserves caller cancellation instead of redacting it", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return jsonResponse(SESSION);
    }));
    const client = createBrowserUseClient(loadTestConfig({ BROWSER_USE_API_KEY: "secret" }));
    const pending = client.listActiveBrowsers(controller.signal);
    const reason = new DOMException("cancelled by user", "AbortError");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
