import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";

interface LegacyCodexAuth {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
}

export interface LegacyCodexAuthMigrationResult {
  migrated: boolean;
  source?: string;
  backup?: string;
}

export async function migrateLegacyCodexAuth(input: {
  agentDir: string;
  logger: Logger;
  legacyAuthPaths?: string[];
}): Promise<LegacyCodexAuthMigrationResult> {
  const agentDir = path.resolve(input.agentDir);
  const targetPath = path.join(agentDir, "auth.json");
  const current = await readJson(targetPath);
  if (isPiAuth(current)) return { migrated: false };
  const existingPiCredentials = piCredentials(current);

  const candidates = uniquePaths([
    targetPath,
    ...(input.legacyAuthPaths ?? []),
  ]);
  for (const sourcePath of candidates) {
    const source = sourcePath === targetPath ? current : await readJson(sourcePath);
    const credential = legacyCredential(source);
    if (!credential) continue;

    await fs.mkdir(agentDir, { recursive: true });
    let backup: string | undefined;
    if (sourcePath === targetPath) {
      backup = path.join(agentDir, "auth.codex-cli.json");
      await copyOnce(sourcePath, backup);
    } else if (await fileExists(targetPath)) {
      backup = path.join(agentDir, "auth.pre-pi.json");
      await copyOnce(targetPath, backup);
    }
    await atomicWriteJson(targetPath, { ...existingPiCredentials, "openai-codex": credential });
    input.logger.info("migrated legacy Codex OAuth credentials to Pi", {
      source: sourcePath,
      target: targetPath,
      backup,
    });
    return { migrated: true, source: sourcePath, backup };
  }

  return { migrated: false };
}

export function legacyCodexAuthCandidates(agentDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = path.dirname(path.resolve(agentDir));
  const configured = env.CODEX_HOME?.trim();
  return uniquePaths([
    ...(configured ? [path.join(configured, "auth.json")] : []),
    path.join(root, "codex", "auth.json"),
  ]);
}

function legacyCredential(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const tokens = (value as LegacyCodexAuth).tokens;
  if (!isRecord(tokens)) return undefined;
  const access = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!access || !refresh) return undefined;

  const payload = decodeJwtPayload(access);
  const expires = typeof payload?.exp === "number" && Number.isFinite(payload.exp)
    ? payload.exp * 1000
    : Date.now();
  const authClaim = isRecord(payload?.["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : undefined;
  const accountId = typeof tokens.account_id === "string"
    ? tokens.account_id
    : typeof authClaim?.chatgpt_account_id === "string"
      ? authClaim.chatgpt_account_id
      : undefined;
  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

function isPiAuth(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const credential = value["openai-codex"];
  return isRecord(credential) && (credential.type === "oauth" || credential.type === "api_key");
}

function piCredentials(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, credential]) =>
    isRecord(credential) && (credential.type === "oauth" || credential.type === "api_key")));
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function copyOnce(source: string, target: string): Promise<void> {
  try {
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((candidate) => path.resolve(candidate)))];
}
