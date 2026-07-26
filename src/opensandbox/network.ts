import { BlockList, isIP } from "node:net";
import type { NetworkPolicy } from "@alibaba-group/opensandbox";

export const DEFAULT_OPENSANDBOX_EGRESS_DNS_UPSTREAM = "1.1.1.1,8.8.8.8";

export const NON_PUBLIC_NETWORK_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/32",
  "2001:2::/48",
  "2001:10::/28",
  "2001:20::/28",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
] as const;

// The pinned opensandbox/egress:v1.1.4 sidecar supports IPv4/IPv6 CIDR
// targets in dns+nft mode despite stale FQDN-only SDK schema comments.
export const PUBLIC_INTERNET_NETWORK_POLICY: NetworkPolicy = {
  defaultAction: "allow",
  egress: NON_PUBLIC_NETWORK_CIDRS.map((target) => ({ action: "deny", target })),
};

export interface OpenSandboxDnsConfig {
  upstream: string;
  nameserverExempt: string;
}

interface ParsedDnsUpstream {
  address: string;
  family: 4 | 6;
  port: number;
}

const nonPublicIpv4Addresses = new BlockList();
const nonPublicIpv6Addresses = new BlockList();
for (const cidr of NON_PUBLIC_NETWORK_CIDRS) {
  const separator = cidr.lastIndexOf("/");
  const address = cidr.slice(0, separator);
  const prefix = Number(cidr.slice(separator + 1));
  if (isIP(address) === 4) {
    nonPublicIpv4Addresses.addSubnet(address, prefix, "ipv4");
  } else {
    nonPublicIpv6Addresses.addSubnet(address, prefix, "ipv6");
  }
}

export function normalizeOpenSandboxDnsUpstreams(value: string): OpenSandboxDnsConfig {
  const rawEntries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (rawEntries.length === 0) {
    throw new Error("must contain at least one public DNS resolver IP");
  }

  const entries: ParsedDnsUpstream[] = [];
  const seenUpstreams = new Set<string>();
  const exemptAddresses: string[] = [];
  const seenExemptAddresses = new Set<string>();

  for (const rawEntry of rawEntries) {
    const entry = parseDnsUpstream(rawEntry);
    if (isNonPublicAddress(entry.address, entry.family)) {
      throw new Error(`resolver ${entry.address} must be a globally routable public IP`);
    }

    const upstream = formatDnsUpstream(entry);
    if (!seenUpstreams.has(upstream)) {
      seenUpstreams.add(upstream);
      entries.push(entry);
    }
    if (!seenExemptAddresses.has(entry.address)) {
      seenExemptAddresses.add(entry.address);
      exemptAddresses.push(entry.address);
    }
  }

  return {
    upstream: entries.map(formatDnsUpstream).join(","),
    nameserverExempt: exemptAddresses.join(","),
  };
}

function parseDnsUpstream(value: string): ParsedDnsUpstream {
  let address = value;
  let port = 53;

  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (!match) throw invalidResolver(value);
    address = match[1]!;
    if (match[2]) port = parsePort(match[2], value);
  } else if (isIP(value) === 0) {
    const match = /^([^:]+):(\d+)$/.exec(value);
    if (!match) throw invalidResolver(value);
    address = match[1]!;
    port = parsePort(match[2]!, value);
  }

  const family = isIP(address);
  if (family !== 4 && family !== 6) throw invalidResolver(value);
  return {
    address: normalizeIpAddress(address, family),
    family,
    port,
  };
}

function parsePort(value: string, resolver: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`resolver ${resolver} has an invalid port`);
  }
  return port;
}

function normalizeIpAddress(address: string, family: 4 | 6): string {
  if (family === 4) return address;
  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

function formatDnsUpstream(entry: ParsedDnsUpstream): string {
  return entry.family === 6
    ? `[${entry.address}]:${entry.port}`
    : `${entry.address}:${entry.port}`;
}

function isNonPublicAddress(address: string, family: 4 | 6): boolean {
  return family === 4
    ? nonPublicIpv4Addresses.check(address, "ipv4")
    : nonPublicIpv6Addresses.check(address, "ipv6");
}

function invalidResolver(value: string): Error {
  return new Error(
    `resolver ${value} must be an IPv4 or IPv6 literal with an optional port`,
  );
}
