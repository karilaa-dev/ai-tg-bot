import { afterEach, describe, expect, it, vi } from "vitest";
import { convertWithDocling } from "../../src/files/docling.js";

describe("docling client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the file-source payload expected by current docling-serve", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ document: { md_content: "converted" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const md = await convertWithDocling({
      config: { DOCLING_URL: "http://docling.test", DOCLING_TIMEOUT_MS: 300_000 },
      filename: "sample.pdf",
      bytes: Buffer.from("abc"),
    });

    expect(md).toBe("converted");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as {
      sources: Array<{ kind: string; base64_string: string; filename: string }>;
      options: Record<string, unknown>;
    };
    expect(body.sources).toEqual([
      { kind: "file", base64_string: Buffer.from("abc").toString("base64"), filename: "sample.pdf" },
    ]);
    expect(body.options).toMatchObject({ to_formats: ["md"], table_mode: "accurate", image_export_mode: "placeholder" });
  });
});
