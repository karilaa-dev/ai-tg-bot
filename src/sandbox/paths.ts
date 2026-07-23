import path from "node:path";
import type { AppConfig } from "../config.js";

const GUEST_ROOT = "/data";

export function botUserRoot(config: Pick<AppConfig, "AGENT_SHARED_ROOT">, userId: number): string {
  return path.join(path.resolve(config.AGENT_SHARED_ROOT), "users", safeId(userId, "user"));
}

export function botSharedRoot(config: Pick<AppConfig, "AGENT_SHARED_ROOT">, userId: number): string {
  return path.join(botUserRoot(config, userId), "shared");
}

export function botThreadWorkspace(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
): string {
  return path.join(botUserRoot(config, userId), "threads", safeId(threadId, "thread"), "workspace");
}

export function botAttachmentRoot(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
): string {
  return path.join(botUserRoot(config, userId), "threads", safeId(threadId, "thread"), "attachments");
}

export function guestThreadWorkspace(threadId: number): string {
  return path.posix.join(GUEST_ROOT, "threads", safeId(threadId, "thread"), "workspace");
}

export function guestAttachmentRoot(threadId: number): string {
  return path.posix.join(GUEST_ROOT, "threads", safeId(threadId, "thread"), "attachments");
}

export function guestCwd(threadId: number, logicalCwd: string): string {
  const normalized = path.posix.normalize(logicalCwd);
  if (!normalized.startsWith("/")) throw new Error("cwd must be an absolute path");
  const workspace = guestThreadWorkspace(threadId);
  if (normalized === "/") return workspace;
  if (isSameOrDescendant(normalized, "/data/shared")) return normalized;
  if (isSameOrDescendant(normalized, workspace)) return normalized;
  if (isSameOrDescendant(normalized, GUEST_ROOT)) {
    throw new Error("cwd must stay in this thread workspace or /data/shared");
  }
  return path.posix.join(workspace, normalized);
}

export function guestCreatedFilePath(threadId: number, virtualPath: string): string {
  return guestCwd(threadId, virtualPath);
}

export function botOutboxRoot(config: Pick<AppConfig, "AGENT_SHARED_ROOT">): string {
  return path.join(path.resolve(config.AGENT_SHARED_ROOT), ".outbox");
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function safeId(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label} id: ${value}`);
  return String(value);
}
