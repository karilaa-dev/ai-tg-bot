import type { NetworkPolicy } from "@alibaba-group/opensandbox";

export const SANDBOX_NETWORK_POLICY_VERSION = "public-internet-v2";

export const NON_PUBLIC_NETWORK_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
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
// targets in dns+nft mode despite stale FQDN-only SDK schema comments. Its DNS
// redirect terminates on 127.0.0.1:15353, so loopback must remain available
// inside the shared sandbox/egress network namespace. Loopback is not a route
// to the Docker host or LAN; those ranges remain denied below.
export const PUBLIC_INTERNET_NETWORK_POLICY: NetworkPolicy = {
  defaultAction: "allow",
  egress: NON_PUBLIC_NETWORK_CIDRS.map((target) => ({ action: "deny", target })),
};
