import { afterEach, describe, expect, it, vi } from "vitest";
import { createCamofoxClient } from "../../src/camofox/client.js";
import { loadTestConfig } from "../../src/config.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

describe("Camofox client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates requests and maps tab lifecycle responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tabId: "tab/1", url: "https://example.com" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCamofoxClient(config());

    const tab = await client.createTab("owner", "interactive", "https://example.com");
    await client.closeTab("owner", tab.tabId);

    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toBe("https://browser.example/tabs");
    expect(createInit.headers.authorization).toBe("Bearer top secret");
    expect(JSON.parse(createInit.body)).toEqual({
      userId: "owner",
      sessionKey: "interactive",
      url: "https://example.com",
    });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/tabs/tab%2F1?userId=owner");
  });

  it("returns snapshot images and raw PNG screenshots", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        url: "https://example.com",
        snapshot: "[heading] Example Domain",
        refsCount: 2,
        totalChars: 24,
        hasMore: false,
        screenshot: { data: PNG.toString("base64"), mimeType: "image/png" },
      }))
      .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCamofoxClient(config());

    const snapshot = await client.snapshot("owner", "tab", { includeScreenshot: true });
    const screenshot = await client.screenshot("owner", "tab", true);

    expect(snapshot.screenshot?.bytes).toEqual(PNG);
    expect(screenshot).toEqual({ bytes: PNG, mediaType: "image/png" });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("fullPage=true");
  });

  it("maps browser downloads and page links", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        downloads: [{ filename: "report.pdf", url: "https://files.example/report.pdf", state: "completed" }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        links: [{ text: "Report", href: "https://files.example/report.pdf", ref: "e7" }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCamofoxClient(config());

    await expect(client.downloads("owner", "tab")).resolves.toEqual([
      { filename: "report.pdf", url: "https://files.example/report.pdf", state: "completed" },
    ]);
    await expect(client.links("owner", "tab")).resolves.toEqual([
      { text: "Report", href: "https://files.example/report.pdf", ref: "e7" },
    ]);
  });

  it("redacts the configured origin and access key from failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "failed for https://browser.example with top secret",
      { status: 500 },
    )));
    const client = createCamofoxClient(config());

    const error = await client.health().catch((failure: unknown) => failure);

    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain("browser.example");
    expect(String(error)).not.toContain("top secret");
  });
});

function config() {
  return loadTestConfig({
    CAMOFOX_URL: "https://browser.example",
    CAMOFOX_ACCESS_KEY: "top secret",
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
