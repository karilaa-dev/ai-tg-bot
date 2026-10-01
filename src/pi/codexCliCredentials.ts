import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type { AppConfig } from "../config.js";
import { raceWithAbort } from "../files/cancel.js";

export const CODEX_PROVIDER_ID = "openai-codex";

type JsonObject = Record<string, unknown>;

interface CodexAuthSnapshot {
  document: JsonObject;
  credential: OAuthCredential;
}

interface CodexCliCredentialDiscovery {
  status: "available" | "missing" | "invalid";
  store?: CredentialStore;
}

export function resolveCodexAuthFile(
  config: Pick<AppConfig, "CODEX_AUTH_FILE">,
  homeDirectory = os.homedir(),
): string {
  const configured = config.CODEX_AUTH_FILE?.trim();
  if (!configured) return path.join(homeDirectory, ".codex", "auth.json");
  if (configured === "~") return homeDirectory;
  if (configured.startsWith("~/")) return path.join(homeDirectory, configured.slice(2));
  return path.resolve(configured);
}

export async function discoverCodexCliCredentials(input: {
  authFile: string;
  onPersistenceError?: (code: string) => void;
}): Promise<CodexCliCredentialDiscovery> {
  const loaded = await loadSnapshot(input.authFile);
  if (loaded.status !== "available") return { status: loaded.status };
  return {
    status: "available",
    store: new CodexCliCredentialStore(input.authFile, input.onPersistenceError),
  };
}

export function isOAuthCredential(value: unknown): value is OAuthCredential {
  if (!isObject(value) || value.type !== "oauth") return false;
  return typeof value.access === "string"
    && value.access.length > 0
    && typeof value.refresh === "string"
    && value.refresh.length > 0
    && typeof value.expires === "number"
    && Number.isFinite(value.expires);
}

export class CodexCliCredentialStore implements CredentialStore {
  private pending: Promise<void> = Promise.resolve();
  private volatileCredential?: OAuthCredential;
  private suppressed = false;

  constructor(
    private authFile: string,
    private readonly onPersistenceError?: (code: string) => void,
    private format: "codex" | "pi" = "codex",
  ) {}

  async status(): Promise<"available" | "missing" | "invalid"> {
    if (this.volatileCredential) return "available";
    return (await loadSnapshot(this.authFile, this.format)).status;
  }

  async saveLogin(piAuthFile: string, credential: OAuthCredential, signal?: AbortSignal): Promise<void> {
    if (!isOAuthCredential(credential)) throw new Error("Invalid Codex OAuth credential.");
    await this.exclusive(async () => {
      signal?.throwIfAborted();
      let document: JsonObject = {};
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(piAuthFile, "utf8"));
        if (isObject(parsed)) document = parsed;
      } catch (error) {
        if (!(error instanceof SyntaxError) && errorCode(error) !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(piAuthFile), { recursive: true, mode: 0o700 });
      // Pi's OAuth SDK does not return the ID token required by Codex CLI's
      // auth.json schema. Store new logins in the bot's native Pi auth file.
      await persistCredential(piAuthFile, document, credential, "pi", signal);
      this.authFile = piAuthFile;
      this.format = "pi";
      this.volatileCredential = undefined;
      this.suppressed = false;
    }, signal);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== CODEX_PROVIDER_ID || this.suppressed) return undefined;
    if (this.volatileCredential) return this.volatileCredential;
    const loaded = await loadSnapshot(this.authFile, this.format);
    return loaded.status === "available" ? loaded.snapshot.credential : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(CODEX_PROVIDER_ID);
    return credential ? [{ providerId: CODEX_PROVIDER_ID, type: "oauth" }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== CODEX_PROVIDER_ID) return fn(undefined);
    return this.exclusive(async () => {
      this.suppressed = false;
      const before = await loadSnapshot(this.authFile, this.format);
      const diskCredential = before.status === "available" ? before.snapshot.credential : undefined;
      const current = this.volatileCredential ?? diskCredential;
      let next: Credential | undefined;
      try {
        next = await fn(current);
      } catch (error) {
        const concurrent = await loadSnapshot(this.authFile, this.format);
        if (concurrent.status === "available"
          && fingerprint(concurrent.snapshot.credential) !== fingerprint(diskCredential)) {
          this.volatileCredential = undefined;
          return concurrent.snapshot.credential;
        }
        throw error;
      }
      if (next === undefined) return current;
      if (!isOAuthCredential(next)) {
        throw new Error("Codex CLI credentials must use OAuth.");
      }

      const latest = await loadSnapshot(this.authFile, this.format);
      if (latest.status === "available"
        && fingerprint(latest.snapshot.credential) !== fingerprint(diskCredential)) {
        this.volatileCredential = undefined;
        return latest.snapshot.credential;
      }

      const baseDocument = latest.status === "available"
        ? latest.snapshot.document
        : before.status === "available"
          ? before.snapshot.document
          : undefined;
      if (!baseDocument) {
        this.volatileCredential = next;
        this.onPersistenceError?.("missing_auth_file");
        return next;
      }
      try {
        await persistCredential(this.authFile, baseDocument, next, this.format);
        this.volatileCredential = undefined;
      } catch (error) {
        this.volatileCredential = next;
        this.onPersistenceError?.(errorCode(error));
      }
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    if (providerId !== CODEX_PROVIDER_ID) return;
    await this.exclusive(async () => {
      // Logging out the bot must not unexpectedly sign the developer out of Codex CLI.
      this.suppressed = true;
      this.volatileCredential = undefined;
    });
  }

  private async exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.pending;
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    // Cancelling a queued login must not release the refresh ahead of it.
    this.pending = previous.then(() => current);
    try {
      await raceWithAbort(previous, signal);
      signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }
}

async function loadSnapshot(authFile: string, format: "codex" | "pi" = "codex"): Promise<
  | { status: "available"; snapshot: CodexAuthSnapshot }
  | { status: "missing" | "invalid" }
> {
  let raw: string;
  try {
    raw = await fs.readFile(authFile, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "missing" } : { status: "invalid" };
  }
  try {
    const document = JSON.parse(raw) as unknown;
    if (format === "pi") {
      if (!isObject(document)) return { status: "invalid" };
      const credential = document[CODEX_PROVIDER_ID];
      if (credential === undefined) return { status: "missing" };
      return isOAuthCredential(credential)
        ? { status: "available", snapshot: { document, credential } }
        : { status: "invalid" };
    }
    if (!isObject(document) || !isObject(document.tokens)) return { status: "invalid" };
    const access = document.tokens.access_token;
    const refresh = document.tokens.refresh_token;
    if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
      return { status: "invalid" };
    }
    const expires = jwtExpiry(access);
    if (expires === undefined) return { status: "invalid" };
    const accountId = typeof document.tokens.account_id === "string"
      ? document.tokens.account_id
      : jwtAccountId(access);
    return {
      status: "available",
      snapshot: {
        document,
        credential: {
          type: "oauth",
          access,
          refresh,
          expires,
          ...(accountId ? { accountId } : {}),
        },
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

async function persistCredential(
  authFile: string,
  document: JsonObject,
  credential: OAuthCredential,
  format: "codex" | "pi" = "codex",
  signal?: AbortSignal,
): Promise<void> {
  const tokens = isObject(document.tokens) ? document.tokens : {};
  const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
  const updated: JsonObject = format === "pi" ? { ...document, [CODEX_PROVIDER_ID]: credential } : {
    ...document,
    tokens: {
      ...tokens,
      access_token: credential.access,
      refresh_token: credential.refresh,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${authFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    signal?.throwIfAborted();
    await fs.rename(temporary, authFile);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function jwtExpiry(token: string): number | undefined {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number" && Number.isFinite(payload.exp)
    ? payload.exp * 1000
    : undefined;
}

function jwtAccountId(token: string): string | undefined {
  const payload = jwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = isObject(auth) ? auth.chatgpt_account_id : payload?.["https://api.openai.com/auth.chatgpt_account_id"];
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

function jwtPayload(token: string): JsonObject | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function fingerprint(credential: OAuthCredential | undefined): string | undefined {
  if (!credential) return undefined;
  return createHash("sha256")
    .update(credential.access)
    .update("\0")
    .update(credential.refresh)
    .update("\0")
    .update(String(credential.expires))
    .digest("hex");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (isObject(error) && typeof error.code === "string") return error.code;
  return "unknown";
}
