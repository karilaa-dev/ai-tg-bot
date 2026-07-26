import { describe, expect, it } from "vitest";
import {
  normalizeOpenSandboxDnsUpstreams,
  PUBLIC_INTERNET_NETWORK_POLICY,
} from "../../src/opensandbox/network.js";

describe("OpenSandbox public-only networking", () => {
  it("normalizes ports, IPv6, and duplicate resolvers", () => {
    expect(normalizeOpenSandboxDnsUpstreams(
      "1.1.1.1, 1.1.1.1:53, 8.8.8.8:5353, [2606:4700:4700:0000::1111]:53",
    )).toEqual({
      upstream: "1.1.1.1:53,8.8.8.8:5353,[2606:4700:4700::1111]:53",
      nameserverExempt: "1.1.1.1,8.8.8.8,2606:4700:4700::1111",
    });
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.100.100.100",
    "127.0.0.1",
    "169.254.169.254",
    "172.17.0.1",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ])("rejects non-public resolver %s", (resolver) => {
    expect(() => normalizeOpenSandboxDnsUpstreams(resolver)).toThrow(
      "must be a globally routable public IP",
    );
  });

  it.each([
    "",
    "dns.google",
    "1.1.1.1:0",
    "1.1.1.1:65536",
    "[2606:4700:4700::1111",
  ])("rejects invalid resolver input %j", (resolver) => {
    expect(() => normalizeOpenSandboxDnsUpstreams(resolver)).toThrow();
  });

  it("uses the same private ranges for resolver validation and sandbox enforcement", () => {
    expect(PUBLIC_INTERNET_NETWORK_POLICY.defaultAction).toBe("allow");
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress).toEqual(expect.arrayContaining([
      { action: "deny", target: "10.0.0.0/8" },
      { action: "deny", target: "100.64.0.0/10" },
      { action: "deny", target: "172.16.0.0/12" },
      { action: "deny", target: "192.168.0.0/16" },
      { action: "deny", target: "fc00::/7" },
      { action: "deny", target: "fe80::/10" },
    ]));
  });
});
