import { describe, expect, it, vi } from "vitest";
import {
  createRetryableOpenSandboxClientProvider,
  formatSandboxError,
  type OpenSandboxClient,
} from "../../src/opensandbox/client.js";

describe("OpenSandbox client provider", () => {
  it("shares successful initialization and retries after failure", async () => {
    const client = {} as OpenSandboxClient;
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(client);
    const provider = createRetryableOpenSandboxClientProvider(factory);

    await expect(provider()).rejects.toThrow("offline");
    const [first, second] = await Promise.all([provider(), provider()]);

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("formats SDK and transport failures without exposing special handling", () => {
    expect(formatSandboxError(new Error("request failed"))).toBe("Error: request failed");
  });
});
