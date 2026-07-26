import path from "node:path";
import type { AppConfig } from "../config.js";

const GUEST_ROOT = "/data";

export function botUserRoot(config: Pick<AppConfig, "AGENT_SHARED_ROOT">, userId: number): string {
  return path.join(path.resolve(config.AGENT_SHARED_ROOT), "users", safeId(userId, "user"));
}

export function botSharedRoot(config: Pick<AppConfig, "AGENT_SHARED_ROOT">, userId: number): string {
  return path.join(botUserRoot(config, userId), "shared");
}

export function botThreadRoot(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
): string {
  return path.join(botUserRoot(config, userId), "threads", safeId(threadId, "thread"));
}

export function botThreadWorkspace(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
): string {
  return path.join(botThreadRoot(config, userId, threadId), "workspace");
}

export function botAttachmentRoot(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
): string {
  return path.join(botThreadRoot(config, userId, threadId), "attachments");
}

export function guestSharedRoot(): string {
  return path.posix.join(GUEST_ROOT, "shared");
}

export function guestThreadRoot(threadId: number): string {
  return path.posix.join(GUEST_ROOT, "threads", safeId(threadId, "thread"));
}

export function guestThreadWorkspace(threadId: number): string {
  return path.posix.join(guestThreadRoot(threadId), "workspace");
}

export function guestAttachmentRoot(threadId: number): string {
  return path.posix.join(guestThreadRoot(threadId), "attachments");
}

export function guestCwd(threadId: number, logicalCwd: string): string {
  const normalized = path.posix.normalize(logicalCwd);
  if (!normalized.startsWith("/")) throw new Error("cwd must be an absolute path");
  const workspace = guestThreadWorkspace(threadId);
  if (normalized === "/") return workspace;
  if (isSameOrDescendant(normalized, guestSharedRoot())) return normalized;
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

export function scopedGuestPathToHostPath(
  config: Pick<AppConfig, "AGENT_SHARED_ROOT">,
  userId: number,
  threadId: number,
  guestPath: string,
): { scopeRoot: string; sourcePath: string } {
  const normalized = path.posix.normalize(guestPath);
  const scopes = [
    {
      guestRoot: guestThreadWorkspace(threadId),
      hostRoot: botThreadWorkspace(config, userId, threadId),
    },
    {
      guestRoot: guestSharedRoot(),
      hostRoot: botSharedRoot(config, userId),
    },
  ];
  const scope = scopes.find(({ guestRoot }) => isSameOrDescendant(normalized, guestRoot));
  if (!scope) throw new Error("created file must be inside the current thread workspace or /data/shared");
  const relative = path.posix.relative(scope.guestRoot, normalized);
  const scopeRoot = path.resolve(scope.hostRoot);
  const sourcePath = path.resolve(scopeRoot, ...relative.split("/").filter(Boolean));
  if (!isSameOrDescendant(sourcePath, scopeRoot)) {
    throw new Error("created file path escapes its mounted sandbox scope");
  }
  return { scopeRoot, sourcePath };
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safeId(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label} id: ${value}`);
  return String(value);
}
