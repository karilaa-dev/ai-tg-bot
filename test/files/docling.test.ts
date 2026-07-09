import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDocling, convertWithDocling } from "../../src/files/docling.js";

describe("docling client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks the Docling server at startup", async () => {
    const fetchMock = vi.fn(async () => new Response("docs", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkDocling({ DOCLING_URL: "http://docling.test/" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://docling.test/docs",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("reports the underlying startup healthcheck failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connection refused") });
    }));

    await expect(checkDocling({ DOCLING_URL: "http://docling.test" })).rejects.toThrow(
      "Docling healthcheck failed at http://docling.test/docs: fetch failed: connection refused",
    );
  });

  it("posts the file-source payload expected by current docling-serve", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ document: { md_content: "converted" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const md = await convertWithDocling({
      config: { DOCLING_URL: "http://docling.test/", DOCLING_TIMEOUT_MS: 300_000 },
      filename: "sample.pdf",
      bytes: Buffer.from("abc"),
    });

    expect(md).toBe("converted");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://docling.test/v1/convert/source");
    const body = JSON.parse(String(init?.body)) as {
      sources: Array<{ kind: string; base64_string: string; filename: string }>;
      options: Record<string, unknown>;
    };
    expect(body.sources).toEqual([
      { kind: "file", base64_string: Buffer.from("abc").toString("base64"), filename: "sample.pdf" },
    ]);
    expect(body.options).toMatchObject({ to_formats: ["md"], table_mode: "accurate", image_export_mode: "placeholder" });
  });

  it("includes the underlying network failure in conversion errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("self-signed certificate in certificate chain") });
    }));

    await expect(convertWithDocling({
      config: { DOCLING_URL: "https://docling.test", DOCLING_TIMEOUT_MS: 300_000 },
      filename: "sample.pdf",
      bytes: Buffer.from("abc"),
    })).rejects.toThrow(
      "Docling request failed at https://docling.test/v1/convert/source: fetch failed: self-signed certificate in certificate chain",
    );
  });
});
