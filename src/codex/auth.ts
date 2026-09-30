import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { asRecord } from "../util/records.js";

type AuthConfig = Pick<AppConfig, "CODEX_HOME" | "CODEX_AUTH_FILE" | "PI_CODING_AGENT_DIR">;
interface AuthPreparationInput { config: AuthConfig; logger?: Logger; homeDirectory?: string }
interface AuthSource { document: Record<string, unknown>; digest: string }
const preparations = new Map<string, Promise<{ home: string; configured: boolean }>>();

/** Codex is the sole token refresher. Existing Pi credentials are imported once. */
export async function prepareCodexAuth(input: AuthPreparationInput): Promise<{ home: string; configured: boolean }> {
  const homeDirectory = input.homeDirectory ?? os.homedir();
  const home = expandPath(input.config.CODEX_HOME, homeDirectory);
  const prior = preparations.get(home);
  if (prior) return prior;
  const pending = prepare(input, home, homeDirectory);
  preparations.set(home, pending);
  try { return await pending; }
  finally { if (preparations.get(home) === pending) preparations.delete(home); }
}

async function prepare(input: AuthPreparationInput, home: string, homeDirectory: string): Promise<{ home: string; configured: boolean }> {
  const result = (configured: boolean) => ({ home, configured });
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  const destination = path.join(home, "auth.json");
  const current = await readNative(destination);
  const explicit = input.config.CODEX_AUTH_FILE?.trim();
  if (explicit) {
    const source = expandPath(explicit, homeDirectory);
    const selected = await readNative(source);
    if (!selected) {
      input.logger?.warn("Configured Codex authentication is unavailable; OpenRouter fallback remains available.");
      return result(false);
    }
    if (current && await sameFile(source, destination)) {
      await makePrivate(destination, input.logger);
      return result(true);
    }
    const marker = await readObject(path.join(home, "auth-source.json"));
    if (current && marker?.source === source && marker.digest === selected.digest) return result(true);
    await installSource(source, selected, destination, true, input.logger);
    input.logger?.info("Codex authentication prepared from the configured source.");
    return result(true);
  }
  if (current) {
    await makePrivate(destination, input.logger);
    return result(true);
  }

  // Pi previously preferred its own OAuth store over the CLI store. Preserve that login.
  const piSource = path.join(expandPath(input.config.PI_CODING_AGENT_DIR, homeDirectory), "auth.json");
  const piDocument = await readObject(piSource);
  const converted = nativeAuthFromPi(piDocument?.["openai-codex"]);
  if (converted) {
    await installDocument(converted, destination);
    input.logger?.info("Existing Pi Codex authentication migrated to the native Codex store.");
    return result(true);
  }

  const source = path.join(homeDirectory, ".codex", "auth.json");
  const selected = await readNative(source);
  if (selected) {
    if (!await sameFile(source, destination)) await installSource(source, selected, destination, false, input.logger);
    input.logger?.info("Codex authentication prepared from the native CLI store.");
    return result(true);
  }
  input.logger?.info("Codex authentication is not configured; OpenRouter fallback remains available.");
  return result(false);
}

async function readObject(file: string): Promise<Record<string, unknown> | undefined> {
  try { return asRecord(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch { return undefined; }
}

async function readNative(file: string): Promise<AuthSource | undefined> {
  const document = await readObject(file);
  if (!document || !validNativeAuth(document)) return undefined;
  return { document, digest: createHash("sha256").update(JSON.stringify(document)).digest("hex") };
}

function validNativeAuth(document: Record<string, unknown>): boolean {
  if ((document.auth_mode == null || document.auth_mode === "apikey") && nonEmpty(document.OPENAI_API_KEY)) return true;
  if (document.auth_mode != null && document.auth_mode !== "chatgpt") return false;
  const tokens = asRecord(document.tokens);
  if (!tokens || !nonEmpty(tokens.access_token) || !nonEmpty(tokens.refresh_token) || !jwtPayload(tokens.id_token)) return false;
  if (tokens.account_id !== undefined && tokens.account_id !== null && !nonEmpty(tokens.account_id)) return false;
  return typeof document.last_refresh === "string" && Number.isFinite(Date.parse(document.last_refresh));
}

function nativeAuthFromPi(value: unknown): Record<string, unknown> | undefined {
  const credential = asRecord(value);
  if (credential?.type !== "oauth" || !nonEmpty(credential.access) || !nonEmpty(credential.refresh)
    || typeof credential.expires !== "number" || !Number.isFinite(credential.expires) || credential.expires <= 0) return undefined;
  const accessClaims = jwtPayload(credential.access);
  if (!accessClaims || typeof accessClaims.exp !== "number" || !Number.isFinite(accessClaims.exp)) return undefined;
  const claimAccount = accountFromClaims(accessClaims);
  const accountId = nonEmpty(credential.accountId) ? credential.accountId : claimAccount;
  if (!accountId || (claimAccount && claimAccount !== accountId)) return undefined;
  const originalIdToken = nonEmpty(credential.idToken) ? credential.idToken : credential.id_token;
  const originalClaims = jwtPayload(originalIdToken);
  if (originalClaims && accountFromClaims(originalClaims) && accountFromClaims(originalClaims) !== accountId) return undefined;
  // Native Codex uses this field for locally parsed claims. Pi did not retain the ID
  // token, so its signed access JWT supplies those claims until native refresh.
  const idToken = originalClaims ? originalIdToken : credential.access;
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: credential.access, refresh_token: credential.refresh, account_id: accountId }, last_refresh: new Date().toISOString() };
}

function jwtPayload(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return undefined;
  try { return asRecord(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))); }
  catch { return undefined; }
}

function accountFromClaims(claims: Record<string, unknown>): string | undefined {
  const account = asRecord(claims["https://api.openai.com/auth"])?.chatgpt_account_id
    ?? claims["https://api.openai.com/auth.chatgpt_account_id"];
  return nonEmpty(account) ? account : undefined;
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function expandPath(value: string, home = os.homedir()): string { return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(value); }

async function sameFile(first: string, second: string): Promise<boolean> {
  try { return await fs.realpath(first) === await fs.realpath(second); }
  catch { return path.resolve(first) === path.resolve(second); }
}

async function writable(file: string): Promise<boolean> {
  try {
    if (((await fs.stat(file)).mode & 0o222) === 0) return false;
    await fs.access(file, constants.W_OK);
    return true;
  } catch { return false; }
}

async function makePrivate(file: string, logger?: Logger): Promise<void> {
  try { await fs.chmod(file, 0o600); }
  catch { logger?.warn("Codex authentication permissions could not be tightened."); }
}

async function installSource(source: string, selected: AuthSource, destination: string, explicit: boolean, logger?: Logger): Promise<void> {
  if (await writable(source)) {
    // The pinned native auth writer opens/truncates the file, preserving this link
    // and persisting refreshes back to the authoritative credential store.
    await replaceFile(destination, temporary => fs.symlink(source, temporary));
    await makePrivate(destination, logger);
    await fs.rm(path.join(path.dirname(destination), "auth-source.json"), { force: true });
  } else {
    await installDocument(selected.document, destination);
    if (explicit) {
      await writeAtomic(path.join(path.dirname(destination), "auth-source.json"), { source, digest: selected.digest });
    }
  }
}

async function installDocument(document: Record<string, unknown>, destination: string): Promise<void> {
  await replaceFile(destination, temporary => fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" }));
}

async function replaceFile(destination: string, create: (temporary: string) => Promise<unknown>): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let backup: string | undefined;
  try {
    await create(temporary);
    try {
      await fs.lstat(destination);
      backup = `${destination}.pre-v3.${randomUUID()}.bak`;
      await fs.rename(destination, backup);
    } catch (error) { if (asRecord(error)?.code !== "ENOENT") throw error; }
    await fs.rename(temporary, destination);
  } catch (error) {
    if (backup) await fs.rename(backup, destination).catch(() => undefined);
    throw error;
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function writeAtomic(destination: string, document: Record<string, unknown>): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
