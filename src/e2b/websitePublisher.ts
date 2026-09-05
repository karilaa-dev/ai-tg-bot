import { throwIfAborted } from "../files/cancel.js";
import type { PublishWebsiteRequest, PublishedWebsite } from "../sandbox/types.js";
import { shellJoin } from "../util/shell.js";
import { E2B_WEBSITE_IDLE_PAUSE_MINUTES, type E2BSandbox } from "./client.js";
import { E2B_WORKSPACE, isSameOrDescendant, sandboxWebsiteDirectory } from "./paths.js";

import { runCommandResult } from "./sandboxCommandExecutor.js";
const WEBSITE_MIN_PORT = 1024;
const WEBSITE_MAX_PORT = 65_535;
const RESERVED_PORTS = new Set([49_983, 49_999, 50_005]);

type WebsiteTarget = { port: number; path: string; siteDirectory: string };
export function websiteTarget(request: PublishWebsiteRequest): WebsiteTarget {
  validateWebsitePort(request.port);
  return { port: request.port, path: normalizeWebsitePath(request.path), siteDirectory: sandboxWebsiteDirectory(request.siteDirectory) };
}

export async function publishWebsite(sandbox: E2BSandbox, target: WebsiteTarget, requestTimeoutMs: number, signal?: AbortSignal): Promise<PublishedWebsite> {
  const siteDirectory = await verifyWebsiteListenerScope(sandbox, target.port, target.siteDirectory, requestTimeoutMs, signal);
  const url = websiteUrlForHost(sandbox.getHost(target.port), target.path);
  await verifyWebsite(url, requestTimeoutMs, signal);
  return { ...target, siteDirectory, sandboxId: sandbox.id, url, pausesAfterMinutes: E2B_WEBSITE_IDLE_PAUSE_MINUTES };
}

function validateWebsitePort(port: number): void {
  if (!Number.isInteger(port) || port < WEBSITE_MIN_PORT || port > WEBSITE_MAX_PORT || RESERVED_PORTS.has(port)) {
    throw new Error(`website port must be an unreserved integer from ${WEBSITE_MIN_PORT} to ${WEBSITE_MAX_PORT}`);
  }
}

function normalizeWebsitePath(value: string | undefined): string {
  const raw = value?.trim() || "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) throw new Error("website path must start with one slash");
  const url = new URL(raw, "https://example.invalid");
  if (url.origin !== "https://example.invalid") throw new Error("website path must be relative to the published host");
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    throw new Error("website path must remain relative after normalization");
  }
  return normalized;
}

function websiteUrlForHost(host: string, sitePath: string): string {
  const source = new URL(sitePath, "https://example.invalid");
  const target = new URL(`https://${host}`);
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = source.hash;
  return target.toString();
}

async function verifyWebsiteListenerScope(
  sandbox: E2BSandbox,
  port: number,
  siteDirectory: string,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const script = [
    "import os,re,subprocess,sys",
    "server_site=os.path.realpath(sys.argv[1])",
    "workspace=os.path.realpath(sys.argv[2])",
    "port=int(sys.argv[3])",
    "if server_site==workspace or os.path.commonpath([server_site,workspace])!=workspace:",
    " raise SystemExit('website directory must be a dedicated workspace subdirectory')",
    "if not os.path.isdir(server_site):",
    " raise SystemExit('website directory does not exist')",
    "probe=subprocess.run(['ss','-H','-ltnp',f'sport = :{port}'],capture_output=True,text=True,check=False)",
    "pids=sorted(set(re.findall(r'pid=(\\d+)',probe.stdout)))",
    "if not pids:",
    " raise SystemExit('website port has no identifiable listening process')",
    "allowed=False",
    "for pid in pids:",
    " try:",
    "  cwd=os.path.realpath(f'/proc/{pid}/cwd')",
    "  if cwd==server_site or os.path.commonpath([cwd,server_site])==server_site:",
    "   allowed=True; break",
    " except (FileNotFoundError,PermissionError,ValueError):",
    "  pass",
    "if not allowed:",
    " raise SystemExit('website listener is not running from the declared site directory')",
    "print(server_site)",
  ].join("\n");
  const result = await runCommandResult(
    sandbox,
    shellJoin(["python3", "-c", script, siteDirectory, E2B_WORKSPACE, String(port)]),
    requestTimeoutMs,
    signal,
    "root",
  );
  const canonical = result.stdout.trim();
  if (canonical === E2B_WORKSPACE || !isSameOrDescendant(canonical, E2B_WORKSPACE)) {
    throw new Error("website listener validation returned an unsafe site directory");
  }
  return canonical;
}

async function verifyWebsite(url: string, requestTimeoutMs: number, signal?: AbortSignal): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + Math.max(5_000, requestTimeoutMs);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const timeoutSignal = AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now())));
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(url, { signal: combined, redirect: "manual" });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`website did not become reachable at ${url}: ${String(lastError)}`);
}
