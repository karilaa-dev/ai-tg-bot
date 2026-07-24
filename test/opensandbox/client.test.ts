import { describe, expect, it, vi } from "vitest";
import {
  createRetryableOpenSandboxClientProvider,
  formatSandboxError,
  PUBLIC_INTERNET_NETWORK_POLICY,
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

  it("denies non-public IPv4 ranges before allowing public traffic", () => {
    expect(PUBLIC_INTERNET_NETWORK_POLICY.defaultAction).toBe("allow");
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress).toEqual(expect.arrayContaining([
      { action: "deny", target: "10.0.0.0/8" },
      { action: "deny", target: "100.64.0.0/10" },
      { action: "deny", target: "169.254.0.0/16" },
      { action: "deny", target: "172.16.0.0/12" },
      { action: "deny", target: "192.168.0.0/16" },
      { action: "deny", target: "224.0.0.0/4" },
      { action: "deny", target: "240.0.0.0/4" },
    ]));
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress?.every((rule) => rule.action === "deny")).toBe(true);
  });
});
