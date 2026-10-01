import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createWebSearchTool } from "../../src/ai/tools/webSearch.js";
import { searchCodexWeb } from "../../src/pi/codexWebSearch.js";
import { CodexCircuitBreaker } from "../../src/pi/circuit.js";

const search = vi.hoisted(() => vi.fn());
vi.mock("@tavily/core", () => ({ tavily: () => ({ search }) }));
beforeEach(() => search.mockReset());

describe("web_search providers", () => {
  const codexResult = { provider: "codex", results: [{ title: "Source", url: "https://example.com", snippet: "" }], answer: "Sourced answer" };
  it.each([
    { provider: "auto" as const, tavily: true, fallback: true },
    { provider: "auto" as const, tavily: false, fallback: false },
    { provider: "codex" as const, tavily: true, fallback: false },
  ])("respects a newly opened circuit in $provider mode with Tavily=$tavily", async ({ provider, tavily, fallback }) => {
    search.mockResolvedValue({ results: [] });
    const config = loadTestConfig({ WEB_SEARCH_PROVIDER: provider, TAVILY_API_KEY: tavily ? "test" : undefined });
    const circuit = new CodexCircuitBreaker();
    const codexModel = vi.fn(() => { throw new Error("Must not prepare a Codex request while blocked"); });
    const runtime = { config, providerRouter: { circuit, codexModel } };
    const tool = createWebSearchTool({ config, codexWebSearch: (query: string, maxResults: number, signal?: AbortSignal) =>
      searchCodexWeb(runtime as never, query, maxResults, signal) } as never);
    // The breaker can open after tools were built, including during an earlier nested call.
    const failure = circuit.acquire();
    if (!failure.allowed) throw new Error("Expected an allowed attempt");
    failure.recordFailure();
    const result = await tool.execute({ query: "facts", max_results: 3 });
    expect(codexModel).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(fallback ? 1 : 0);
    expect(result).toEqual(fallback ? { results: [] } : { error: expect.stringContaining("temporarily unavailable") });
  });
  it("prefers Codex without requiring a Tavily key", async () => {
    const codexWebSearch = vi.fn().mockResolvedValue(codexResult);
    const tool = createWebSearchTool({ config: loadTestConfig({ TAVILY_API_KEY: undefined }), codexWebSearch } as never);
    expect(await tool.execute({ query: "facts", max_results: 3 })).toEqual(codexResult);
    expect(codexWebSearch).toHaveBeenCalledWith("facts", 3, undefined);
    expect(search).not.toHaveBeenCalled();
  });
  it("falls back only in auto mode and never after cancellation", async () => {
    search.mockResolvedValue({ results: [] });
    const codexWebSearch = vi.fn().mockRejectedValue(new Error("quota exhausted"));
    const input = { config: loadTestConfig(), codexWebSearch };
    expect(await createWebSearchTool(input as never).execute({ query: "facts", max_results: 3 })).toEqual({ results: [] });
    expect(search).toHaveBeenCalledOnce();
    input.config.WEB_SEARCH_PROVIDER = "codex";
    expect(await createWebSearchTool(input as never).execute({ query: "facts", max_results: 3 })).toMatchObject({ error: expect.stringContaining("quota") });
    expect(search).toHaveBeenCalledOnce();
    input.config.WEB_SEARCH_PROVIDER = "auto";
    const controller = new AbortController();
    codexWebSearch.mockImplementation(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
    await expect(createWebSearchTool(input as never).execute({ query: "facts", max_results: 3 }, controller.signal)).rejects.toThrow("cancelled");
    expect(search).toHaveBeenCalledOnce();
  });
  it("honors forced Tavily and reports missing image support in forced Codex mode", async () => {
    search.mockResolvedValue({ results: [] });
    const codexWebSearch = vi.fn().mockResolvedValue(codexResult);
    const config = loadTestConfig({ WEB_SEARCH_PROVIDER: "tavily" });
    await createWebSearchTool({ config, codexWebSearch } as never).execute({ query: "facts", max_results: 3 });
    expect(codexWebSearch).not.toHaveBeenCalled();
    config.WEB_SEARCH_PROVIDER = "codex";
    const output = await createWebSearchTool({ config, codexWebSearch } as never).execute({ query: "photos", max_results: 3, include_images: true });
    expect(output).toMatchObject({ provider: "codex", images: [], warning: expect.stringContaining("image candidates") });
  });
});

describe("web_search image discovery", () => {
  it("requests described image candidates and returns bounded original URLs", async () => {
    search.mockResolvedValue({
      results: [
        { title: "Tokyo", url: "https://example.com/tokyo", content: "Source" },
      ],
      images: Array.from({ length: 12 }, (_, n) => ({
        url: `https://example.com/photo-${n}.jpg`,
        description: "Tokyo skyline",
      })),
    });
    const tool = createWebSearchTool({ config: loadTestConfig() } as never);
    const output = await tool.execute({
      query: "Tokyo skyline photos",
      max_results: 5,
      include_images: true,
    });
    expect(search).toHaveBeenLastCalledWith(
      "Tokyo skyline photos",
      expect.objectContaining({
        includeImages: true,
        includeImageDescriptions: true,
      }),
    );
    expect(output).toMatchObject({
      results: [{ url: "https://example.com/tokyo" }],
      images: expect.arrayContaining([
        {
          url: "https://example.com/photo-0.jpg",
          description: "Tokyo skyline",
        },
      ]),
    });
    expect("images" in output && output.images).toHaveLength(10);
  });

  it("keeps ordinary text searches free of image output", async () => {
    search.mockResolvedValue({ results: [], images: [] });
    const tool = createWebSearchTool({ config: loadTestConfig() } as never);
    expect(
      await tool.execute({ query: "Tokyo policy", max_results: 5 }),
    ).toEqual({ results: [] });
    expect(search).toHaveBeenLastCalledWith(
      "Tokyo policy",
      expect.objectContaining({ includeImages: false }),
    );
  });
});
