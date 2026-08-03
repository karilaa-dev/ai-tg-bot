import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch, interceptors, type Dispatcher } from "undici";
import { raceWithAbort, throwIfAborted } from "../files/cancel.js";
import { MAX_FILE_BYTES } from "../files/limits.js";

const MAX_REDIRECTS = 5;
const MAX_ERROR_BYTES = 8 * 1024;
const NON_PUBLIC_ADDRESSES = createNonPublicBlockList();

export interface DownloadedBrowserFile {
  bytes: Buffer;
  mimeType?: string;
  finalUrl: string;
}

type DownloadFetch = (
  url: URL,
  init: RequestInit & { dispatcher: Dispatcher },
) => Promise<Response>;

const defaultDownloadFetch = undiciFetch as unknown as DownloadFetch;

export async function downloadPublicBrowserFile(
  sourceUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
  request: DownloadFetch = defaultDownloadFetch,
): Promise<DownloadedBrowserFile> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let url = parseDownloadUrl(sourceUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    throwIfAborted(operationSignal);
    const addresses = await resolvePublicAddresses(url);
    const dispatcher = pinnedDispatcher(addresses, timeoutMs);
    try {
      const response = await raceWithAbort(request(url, {
        method: "GET",
        headers: { accept: "*/*" },
        redirect: "manual",
        signal: operationSignal,
        dispatcher,
      }), operationSignal);

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error("Browser download redirect did not include a location.");
        if (redirects === MAX_REDIRECTS) throw new Error("Browser download redirected too many times.");
        url = parseDownloadUrl(new URL(location, url).toString());
        continue;
      }

      if (!response.ok) {
        const detail = (await readLimitedResponse(response, MAX_ERROR_BYTES).catch(() => Buffer.alloc(0)))
          .toString("utf8")
          .trim();
        throw new Error(`Browser download HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const bytes = await readLimitedResponse(response, MAX_FILE_BYTES);
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
      return { bytes, mimeType, finalUrl: url.toString() };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  throw new Error("Browser download redirected too many times.");
}

function parseDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser download URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser downloads require public HTTP(S) URLs.");
  }
  if (url.username || url.password) throw new Error("Browser download URLs cannot contain credentials.");
  return url;
}

async function resolvePublicAddresses(url: URL): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Browser downloads from local or private hosts are blocked.");
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => isNonPublicAddress(address, family))) {
    throw new Error("Browser downloads from local or private hosts are blocked.");
  }
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function pinnedDispatcher(
  addresses: Array<{ address: string; family: 4 | 6 }>,
  operationTimeoutMs: number,
): Dispatcher {
  // The dispatcher is used for one manually redirected request and then closed.
  // Cache only the already-validated addresses for its entire possible lifetime;
  // the custom lookup never delegates back to system DNS.
  const pinLifetimeMs = Math.max(1, operationTimeoutMs);
  return new Agent().compose(interceptors.dns({
    maxTTL: pinLifetimeMs,
    lookup: (_origin, _options, callback) => callback(null, addresses.map((address) => ({
      ...address,
      ttl: pinLifetimeMs,
    }))),
  }));
}

function isNonPublicAddress(address: string, family: number): boolean {
  if (family === 4) return NON_PUBLIC_ADDRESSES.check(address, "ipv4");
  if (family === 6) {
    if (address.toLowerCase().includes("::ffff:")) return true;
    return NON_PUBLIC_ADDRESSES.check(address, "ipv6");
  }
  return true;
}

function createNonPublicBlockList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ] as const) list.addSubnet(network, prefix, "ipv6");
  return list;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Browser download is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Browser download is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}
