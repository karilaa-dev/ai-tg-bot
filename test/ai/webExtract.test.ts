import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebExtractTool } from "../../src/ai/tools/webExtract.js";
import { loadTestConfig } from "../../src/config.js";

const tavilyMocks = vi.hoisted(() => ({ extract: vi.fn() }));

vi.mock("@tavily/core", () => ({
  tavily: () => ({ extract: tavilyMocks.extract }),
}));

describe("web_extract", () => {
  beforeEach(() => tavilyMocks.extract.mockReset());

  it("always performs a single stateless Tavily extraction", async () => {
    tavilyMocks.extract.mockResolvedValue({
      results: [{ url: "https://example.com/", rawContent: "Example content" }],
      failedResults: [],
      responseTime: 0.2,
      requestId: "request-1",
    });
    const tool = createWebExtractTool({
      config: loadTestConfig({ BROWSER_USE_API_KEY: "browser-key" }),
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
    expect(tavilyMocks.extract).toHaveBeenCalledTimes(1);
    expect(tavilyMocks.extract).toHaveBeenCalledWith(["https://example.com"], {
      extractDepth: "advanced",
      format: "markdown",
      includeImages: false,
      includeFavicon: false,
      query: "main point",
      chunksPerSource: 2,
    });
  });
});
