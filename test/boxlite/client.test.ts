import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  boxlitePlatformUnavailableReason,
  createBoxClient,
  createRetryableBoxClientProvider,
  formatBoxliteError,
  resolveBoxliteHome,
} from "../../src/boxlite/client.js";
import type { BoxClient } from "../../src/boxlite/types.js";
import { loadTestConfig } from "../../src/config.js";

describe("BoxLite client", () => {
  it("constructs the embedded runtime lazily and shares concurrent initialization", async () => {
    const client = {} as BoxClient;
    const factory = vi.fn(async () => client);
    const provider = createRetryableBoxClientProvider(factory);

    expect(factory).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([provider(), provider()]);

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(provider()).resolves.toBe(client);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("allows initialization to retry after a failure", async () => {
    const client = {} as BoxClient;
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("KVM unavailable"))
      .mockResolvedValue(client);
    const provider = createRetryableBoxClientProvider(factory);

    await expect(provider()).rejects.toThrow("KVM unavailable");
    await expect(provider()).resolves.toBe(client);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("resolves the embedded runtime home to an absolute path", () => {
    expect(resolveBoxliteHome({ BOXLITE_HOME: "./data/boxlite" }))
      .toBe(path.resolve("./data/boxlite"));
  });

  it("supports native Apple Silicon macOS and explains unsupported Mac hosts", () => {
    expect(boxlitePlatformUnavailableReason("darwin", "arm64", "21.0.0")).toBeUndefined();
    expect(boxlitePlatformUnavailableReason("darwin", "x64", "25.0.0"))
      .toContain("Intel Macs and x64 Node under Rosetta are unsupported");
    expect(boxlitePlatformUnavailableReason("darwin", "arm64", "20.6.0"))
      .toContain("requires macOS 12 or later");
    expect(boxlitePlatformUnavailableReason("linux", "x64", "6.12.0")).toBeUndefined();
  });

  it("reports a nonfatal entrypoint preflight failure before importing BoxLite", async () => {
    vi.stubEnv("BOXLITE_UNAVAILABLE_REASON", "/dev/kvm is missing");
    try {
      await expect(createBoxClient(loadTestConfig())).rejects.toThrow(
        "BoxLite is unavailable: /dev/kvm is missing",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("formats native errors without credential-specific handling", () => {
    expect(formatBoxliteError(new Error("runtime failed"))).toBe("Error: runtime failed");
  });
});
