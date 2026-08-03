import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebExtractTool } from "../../src/ai/tools/webExtract.js";
import { loadTestConfig } from "../../src/config.js";

const fetchMock = vi.fn<typeof fetch>();

describe("web_extract", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("always performs a single stateless Tavily extraction", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [{ url: "https://example.com/", raw_content: "Example content" }],
      failed_results: [],
      response_time: 0.2,
      request_id: "request-1",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const tool = createWebExtractTool({
      config: loadTestConfig({ TAVILY_API_KEY: "tavily-key", BROWSER_USE_API_KEY: "browser-key" }),
      user: { tg_id: 9 },
      thread: { id: 10 },
    } as never);

    const result = await tool.execute({
      urls: ["https://example.com"],
      query: "main point",
      chunks_per_source: 2,
      extract_depth: "advanced",
      format: "markdown",
      include_images: false,
      include_favicon: false,
      max_chars_per_url: 12_000,
    });

    expect(result).toMatchObject({
      provider: "tavily",
      results: [{ url: "https://example.com/", content: "Example content" }],
      failed_results: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/extract", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer tavily-key" }),
      body: JSON.stringify({
        urls: ["https://example.com"],
        extract_depth: "advanced",
        format: "markdown",
        include_images: false,
        include_favicon: false,
        query: "main point",
        chunks_per_source: 2,
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(timeoutSpy).toHaveBeenCalledWith(35_000);
  });

  it("keeps a client-side response margin beyond Tavily's extraction budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [],
      failed_results: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const tool = createWebExtractTool({
      config: loadTestConfig({ TAVILY_API_KEY: "tavily-key" }),
      user: { tg_id: 9 },
      thread: { id: 10 },
    } as never);

    await tool.execute({
      urls: ["https://example.com"],
      chunks_per_source: 3,
      extract_depth: "basic",
      format: "markdown",
      include_images: false,
      include_favicon: false,
      timeout: 12,
      max_chars_per_url: 12_000,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ timeout: 12 });
    expect(timeoutSpy).toHaveBeenCalledWith(17_000);
  });

  it("aborts the underlying extraction request when the tool is cancelled", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    });
    const tool = createWebExtractTool({
      config: loadTestConfig({ TAVILY_API_KEY: "tavily-key" }),
      user: { tg_id: 9 },
      thread: { id: 10 },
    } as never);
    const reason = new Error("turn cancelled");

    const result = tool.execute({
      urls: ["https://example.com"],
      chunks_per_source: 3,
      format: "markdown",
      extract_depth: "basic",
      include_images: false,
      include_favicon: false,
      max_chars_per_url: 12_000,
    }, controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });
});
