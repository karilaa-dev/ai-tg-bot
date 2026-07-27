import { describe, expect, it } from "vitest";
import {
  NON_PUBLIC_NETWORK_CIDRS,
  PUBLIC_INTERNET_NETWORK_POLICY,
  SANDBOX_NETWORK_POLICY_VERSION,
} from "../../src/opensandbox/network.js";

describe("OpenSandbox public-only networking", () => {
  it("allows loopback for the stock egress DNS proxy while denying routed non-public networks", () => {
    expect(SANDBOX_NETWORK_POLICY_VERSION).toBe("public-internet-v3");
    expect(PUBLIC_INTERNET_NETWORK_POLICY.defaultAction).toBe("allow");
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress).toEqual(expect.arrayContaining([
      { action: "deny", target: "0.0.0.0/8" },
      { action: "deny", target: "10.0.0.0/8" },
      { action: "deny", target: "100.64.0.0/10" },
      { action: "deny", target: "169.254.0.0/16" },
      { action: "deny", target: "172.16.0.0/12" },
      { action: "deny", target: "192.168.0.0/16" },
      { action: "deny", target: "198.18.0.0/15" },
      { action: "deny", target: "224.0.0.0/4" },
      { action: "deny", target: "240.0.0.0/4" },
      { action: "deny", target: "2001:db8::/32" },
      { action: "deny", target: "fc00::/7" },
      { action: "deny", target: "fe80::/10" },
      { action: "deny", target: "ff00::/8" },
    ]));
    expect(NON_PUBLIC_NETWORK_CIDRS).not.toContain("127.0.0.0/8");
    expect(NON_PUBLIC_NETWORK_CIDRS).not.toContain("::1/128");
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress?.every((rule) => rule.action === "deny")).toBe(true);
  });
});
