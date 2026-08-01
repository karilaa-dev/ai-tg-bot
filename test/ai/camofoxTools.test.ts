import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";

const browserDownload = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock("../../src/camofox/download.js", () => ({
  downloadPublicBrowserFile: browserDownload.download,
}));

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

describe("Camofox Pi tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    browserDownload.download.mockReset();
  });

  it("registers only when configured and keeps browser operations sequential", () => {
    const disabled = createPiToolAdapters(bridge(loadTestConfig()));
    expect(disabled.some((tool) => tool.name.startsWith("camofox_"))).toBe(false);
    expect(disabled.some((tool) => tool.name === "render_office_preview")).toBe(false);

    const enabled = createPiToolAdapters(bridge(camofoxConfig()));
    expect(enabled.find((tool) => tool.name === "camofox_create_tab")?.executionMode).toBe("sequential");
    expect(enabled.find((tool) => tool.name === "render_office_preview")?.executionMode).toBe("sequential");
  });

  it("creates per-thread tabs and returns screenshots without persisting base64 details", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tabId: "tab-1", url: "https://example.com" }))
      .mockResolvedValueOnce(jsonResponse({
        url: "https://example.com",
        snapshot: "[heading] Example Domain",
        refsCount: 1,
        totalChars: 24,
        hasMore: false,
        screenshot: { data: PNG.toString("base64"), mimeType: "image/png" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = createPiToolAdapters(bridge(camofoxConfig()));
    const create = tools.find((tool) => tool.name === "camofox_create_tab")!;
    const snapshot = tools.find((tool) => tool.name === "camofox_snapshot")!;

    const created = await create.execute(
      "create",
      { url: "https://example.com" },
      undefined,
      undefined,
      {} as never,
    );
    const viewed = await snapshot.execute(
      "snapshot",
      { tab_id: "tab-1" },
      undefined,
      undefined,
      {} as never,
    );

    expect(created.details).toMatchObject({ tab_id: "tab-1" });
    expect(viewed.content.some((part) => part.type === "image" && part.data === PNG.toString("base64"))).toBe(true);
    expect(viewed.details).not.toHaveProperty("screenshot_base64");
    const createBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(createBody.userId).toMatch(/^ai-tg-bot-[a-f0-9]{40}$/);
    expect(createBody.userId).not.toContain("9910");
  });

  it("attaches explicit browser screenshots directly to Telegram delivery", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { width: 1920, height: 1388 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const createdFiles: unknown[] = [];
    const stored = {
      id: 71,
      type: "image",
      name: "browser-screenshot.png",
      mime_type: "image/png",
      size: PNG.length,
      is_inline: 1,
    };
    const insertFile = vi.fn(async (input: Record<string, unknown>) => ({ ...stored, ...input, id: stored.id }));
    const tools = createPiToolAdapters(bridge(camofoxConfig(), {
      createdFiles,
      repos: { files: { insertFile, get: vi.fn(async () => stored) } },
    }));
    const screenshot = tools.find((tool) => tool.name === "camofox_screenshot")!;

    const result = await screenshot.execute(
      "shot",
      { tab_id: "tab-1", caption: "Page screenshot" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      attached: true,
      file_id: 71,
      screenshot_size: PNG.length,
      full_page: false,
      viewport: { width: 1920, height: 1388 },
      delivery: "photo",
    });
    expect(result.details).not.toHaveProperty("screenshot_base64");
    expect(createdFiles).toHaveLength(1);
    expect(createdFiles[0]).toMatchObject({
      fileId: 71,
      type: "image",
      data: PNG,
      delivery: "photo",
      caption: "Page screenshot",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ width: 1920, height: 1080 });
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toMatchObject({ width: 1920, height: 1388 });
    expect(String(fetchMock.mock.calls[3]![0])).toContain("fullPage=false");
  });

  it("sends a Camofox screenshot as a document when explicitly selected", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { width: 1920, height: 995 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const createdFiles: unknown[] = [];
    const stored = {
      id: 73,
      type: "image",
      name: "browser-screenshot.png",
      mime_type: "image/png",
      size: PNG.length,
      is_inline: 1,
    };
    const tools = createPiToolAdapters(bridge(camofoxConfig(), {
      createdFiles,
      repos: {
        files: {
          insertFile: vi.fn(async (input: Record<string, unknown>) => ({ ...stored, ...input, id: stored.id })),
          get: vi.fn(async () => stored),
        },
      },
    }));
    const screenshot = tools.find((tool) => tool.name === "camofox_screenshot")!;

    const result = await screenshot.execute(
      "shot-file",
      { tab_id: "tab-1", delivery: "document" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ attached: true, delivery: "document", full_page: false });
    expect(createdFiles[0]).toMatchObject({ fileId: 73, delivery: "document", data: PNG });
  });

  it("attaches completed Camofox downloads without E2B", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      downloads: [{ filename: "report.zip", url: "https://93.184.216.34/report.zip", state: "completed" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    browserDownload.download.mockResolvedValue({
      bytes: Buffer.from("zip-data"),
      mimeType: "application/zip",
      finalUrl: "https://93.184.216.34/report.zip",
    });
    const createdFiles: unknown[] = [];
    const insertFile = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      id: 72,
      mime_type: input.mimeType,
      is_inline: 0,
    }));
    const tools = createPiToolAdapters(bridge(camofoxConfig(), {
      createdFiles,
      repos: { files: { insertFile } },
    }));
    const sendDownload = tools.find((tool) => tool.name === "camofox_send_file")!;

    const result = await sendDownload.execute(
      "download",
      { tab_id: "tab-1", download_index: 0, caption: "Requested file" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ attached: true, file_id: 72, name: "report.zip", size: 8 });
    expect(createdFiles[0]).toMatchObject({
      fileId: 72,
      type: "other",
      data: Buffer.from("zip-data"),
      delivery: "document",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browserDownload.download).toHaveBeenCalledWith(
      "https://93.184.216.34/report.zip",
      30_000,
      undefined,
    );
  });
});

function camofoxConfig() {
  return loadTestConfig({
    CAMOFOX_URL: "https://browser.example",
    CAMOFOX_ACCESS_KEY: "secret",
  });
}

function bridge(config: ReturnType<typeof loadTestConfig>, extra: Record<string, unknown> = {}) {
  return {
    buildInput: () => ({
      config,
      repos: {},
      user: { tg_id: 9910 },
      thread: { id: 44 },
      ...extra,
    } as never),
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
