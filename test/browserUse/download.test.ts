import { describe, expect, it, vi } from "vitest";
import { downloadPublicBrowserFile } from "../../src/browserUse/download.js";

describe("Browser Use direct downloads", () => {
  it.each(["http://127.0.0.1/private", "http://[::1]/private", "http://[::ffff:127.0.0.1]/private"])("blocks private network target %s before fetching", async (url) => {
    const fetchMock = vi.fn();
    await expect(downloadPublicBrowserFile(url, 1_000, undefined, fetchMock))
      .rejects.toThrow("local or private hosts");
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
    )).rejects.toThrow("local or private hosts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["https://93.184.216.34/file.bin", "https://[2606:4700:4700::1111]/file.bin"])("returns a bounded public response from %s", async (url) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("file-data"), {
      headers: { "content-type": "application/octet-stream", "content-length": "9" },
    }));
    await expect(downloadPublicBrowserFile(
      url,
      1_000,
      undefined,
      fetchMock,
    )).resolves.toMatchObject({
      bytes: Buffer.from("file-data"),
      mimeType: "application/octet-stream",
      finalUrl: url,
    });
  });
});
