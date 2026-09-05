import { describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createWebSearchTool } from "../../src/ai/tools/webSearch.js";

const search = vi.hoisted(() => vi.fn());
vi.mock("@tavily/core", () => ({ tavily: () => ({ search }) }));

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
