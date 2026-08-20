import path from "node:path";

export const E2B_WORKSPACE = "/home/user/workspace";
export const E2B_TELEGRAM_FILES = "/home/user/telegram-files";
export const E2B_FILE_SOURCES = "/home/user/.ai-tg-bot/file-sources";
export const E2B_RUNTIME_TMP = "/tmp/ai-tg-bot";
export const E2B_CONTROL_TMP = "/tmp/ai-tg-bot-control";

export function sandboxWorkingDirectory(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  if (normalized === "/") return E2B_WORKSPACE;
  if (isSameOrDescendant(normalized, E2B_WORKSPACE)) return normalized;
  if (isSameOrDescendant(normalized, E2B_TELEGRAM_FILES)) return normalized;
  return path.posix.join(E2B_WORKSPACE, normalized);
}

export function sandboxWorkspaceFile(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  const candidate = isSameOrDescendant(normalized, E2B_WORKSPACE)
    ? normalized
    : path.posix.join(E2B_WORKSPACE, normalized);
  if (!isSameOrDescendant(candidate, E2B_WORKSPACE)) {
    throw new Error("created file must be inside /home/user/workspace");
  }
  return candidate;
}

export function sandboxWebsiteDirectory(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  if (isSameOrDescendant(normalized, E2B_TELEGRAM_FILES)) {
    throw new Error("published website directory cannot contain Telegram files");
  }
  const candidate = path.posix.normalize(isSameOrDescendant(normalized, E2B_WORKSPACE)
    ? normalized
    : path.posix.join(E2B_WORKSPACE, normalized)).replace(/\/+$/u, "") || "/";
  if (candidate === E2B_WORKSPACE || !isSameOrDescendant(candidate, E2B_WORKSPACE)) {
    throw new Error("published website directory must be a dedicated subdirectory of /home/user/workspace");
  }
  return candidate;
}

export function normalizeVirtualPath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!normalized.startsWith("/")) throw new Error("path must be absolute");
  return normalized;
}

export function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}
