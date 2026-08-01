import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebExtractTool } from "../../src/ai/tools/webExtract.js";
import { loadTestConfig } from "../../src/config.js";

describe("Camofox web extraction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads accessibility text and destroys its disposable session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tabId: "tab-1", url: "https://example.com" }))
      .mockResolvedValueOnce(jsonResponse({
        url: "https://example.com/",
        snapshot: "[heading] Example Domain\n[paragraph] Example content",
        refsCount: 0,
        totalChars: 52,
        hasMore: false,
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, closed: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadTestConfig({
      WEB_EXTRACT_PROVIDER: "camofox",
      CAMOFOX_URL: "https://browser.example",
      CAMOFOX_ACCESS_KEY: "secret",
    });
    const tool = createWebExtractTool({
      config,
      user: { tg_id: 9 },
      thread: { id: 10 },
    } as never);

    const result = await tool.execute({
      urls: ["https://example.com"],
      query: "ignored by Camofox",
      chunks_per_source: 3,
      extract_depth: "advanced",
      format: "markdown",
      include_images: false,
      include_favicon: false,
      max_chars_per_url: 12_000,
    });

    expect(result).toMatchObject({
      provider: "camofox",
      failed_results: [],
      results: [{
        url: "https://example.com/",
        content: expect.stringContaining("Example Domain"),
        truncated: false,
      }],
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/sessions/") && call[1].method === "DELETE"))
      .toBe(true);
    expect(fetchMock.mock.calls.every((call) => call[1].headers.authorization === "Bearer secret")).toBe(true);
  });

  it("stops pagination when a server reports more pages without returning text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tabId: "tab-1", url: "https://example.com" }))
      .mockResolvedValueOnce(jsonResponse({
        url: "https://example.com/",
        snapshot: "",
        refsCount: 0,
        totalChars: 100,
        hasMore: true,
        nextOffset: 50,
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, closed: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebExtractTool({
      config: loadTestConfig({
        WEB_EXTRACT_PROVIDER: "camofox",
        CAMOFOX_URL: "https://browser.example",
        CAMOFOX_ACCESS_KEY: "secret",
      }),
      user: { tg_id: 9 },
      thread: { id: 10 },
    } as never);

    const result = await tool.execute(defaultInput());

    expect(result).toMatchObject({ results: [{ content: "", truncated: true }] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

function defaultInput() {
  return {
    urls: ["https://example.com"],
    chunks_per_source: 3,
    extract_depth: "basic" as const,
    format: "markdown" as const,
    include_images: false,
    include_favicon: false,
    max_chars_per_url: 12_000,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
