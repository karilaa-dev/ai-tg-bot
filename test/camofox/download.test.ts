import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPublicBrowserFile } from "../../src/camofox/download.js";

describe("Camofox browser downloads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks private network download targets before fetching", async () => {
    const fetchMock = vi.fn();
    await expect(downloadPublicBrowserFile("http://127.0.0.1/private", 1_000, undefined, fetchMock)).rejects.toThrow(
      "local or private hosts",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates every redirect target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));
    await expect(downloadPublicBrowserFile(
      "https://93.184.216.34/file",
      1_000,
      undefined,
      fetchMock,
    )).rejects.toThrow(
      "local or private hosts",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded public response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("file-data"), {
      headers: { "content-type": "application/octet-stream", "content-length": "9" },
    }));

    await expect(downloadPublicBrowserFile(
      "https://93.184.216.34/file.bin",
      1_000,
      undefined,
      fetchMock,
    )).resolves.toMatchObject({
      bytes: Buffer.from("file-data"),
      mimeType: "application/octet-stream",
      finalUrl: "https://93.184.216.34/file.bin",
    });
  });
});
