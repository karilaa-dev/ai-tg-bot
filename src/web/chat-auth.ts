import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AccessControl } from "../access/control.js";
import { WebHttpError } from "./auth.js";

const ISSUER = "https://oauth.telegram.org";
const SESSION_MS = 12 * 60 * 60_000;
const TRANSACTION_MS = 10 * 60_000;
const MAX_ENTRIES = 4_096;
const MAX_USER_SESSIONS = 8;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest();
const key = (value: string) => hash(value).toString("hex");
const equal = (a: string, b: string) => timingSafeEqual(hash(a), hash(b));

type TelegramFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
export interface TelegramAuthDependencies { jwks?: JWTVerifyGetKey; fetch?: TelegramFetch; authorizeUrl?: string }

type AuthConfig = Pick<AppConfig, "WEB_TELEGRAM_CLIENT_ID" | "WEB_TELEGRAM_CLIENT_SECRET" | "WEB_PUBLIC_URL" | "WEB_ADMIN_USER_IDS">;
/** Pages a finished sign-in may return to; anything else lands on the chat. */
const RETURN_PATHS = new Set(["/", "/admin"]);
interface Transaction { browser: string; verifier: string; nonce: string; returnTo: string; expires: number }
interface Session { userId: number; expires: number }

/** Bounded fixed-window request budgets. */
export class ChatRateLimit {
  private readonly entries = new Map<string, { count: number; expires: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}
  take(id: string) {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    const entry = this.entries.get(id);
    if (entry && entry.count >= this.limit) {
      throw new WebHttpError(429, "Too many requests. Try again shortly.", { "Retry-After": String(Math.max(1, Math.ceil((entry.expires - now) / 1_000))) });
    }
    if (entry) entry.count++;
    else {
      if (this.entries.size >= MAX_ENTRIES) throw new WebHttpError(429, "Too many requests. Try again shortly.", { "Retry-After": "60" });
      this.entries.set(id, { count: 1, expires: now + this.windowMs });
    }
  }
  clear() { this.entries.clear(); }
}

export function requireChatMutation(request: Request, publicUrl?: string) {
  const site = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  if (request.headers.get("X-Chat-Request") !== "1" || (site !== null && site !== "same-origin")
    || (origin !== null && origin !== (publicUrl ?? new URL(request.url).origin))) {
    throw new WebHttpError(403, "This action must come from this website.");
  }
}

/** Walk from the trusted socket peer toward the first untrusted hop. */
export function chatClientAddress(request: Request, peer: string | undefined, trustedProxies: readonly string[]) {
  if (!peer || !trustedProxies.includes(peer)) return peer ?? "unknown";
  const forwarded = request.headers.get("X-Forwarded-For");
  if (!forwarded || forwarded.length > 2_048) return peer;
  const addresses = forwarded.split(",").map(address => address.trim());
  if (addresses.length > 20 || addresses.some(address => isIP(address) === 0)) return peer;
  for (const address of addresses.reverse()) if (!trustedProxies.includes(address)) return address;
  return peer;
}

const IdentitySchema = z.object({
  id: z.union([z.number(), z.string().regex(/^[1-9]\d{0,15}$/).transform(Number)])
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
});
const TokenResponseSchema = z.object({ id_token: z.string().min(1).max(32_768), error: z.never().optional() });

/** Telegram's opaque `sub` is not its Bot API user ID. Only the signed `id` is used. */
export async function verifyTelegramIdentity(idToken: string, nonce: string, clientId: string, jwks: JWTVerifyGetKey): Promise<number> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "nonce", "id"], maxTokenAge: "10m", clockTolerance: 5,
  });
  if (typeof payload.nonce !== "string" || !equal(payload.nonce, nonce)
    || typeof payload.sub !== "string" || !payload.sub
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
    || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error("Invalid Telegram identity");
  return IdentitySchema.parse(payload).id;
}

export class WebChatAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly transactions = new Map<string, Transaction>();
  private readonly starts = new ChatRateLimit(10);
  private readonly globalStarts = new ChatRateLimit(120);
  private readonly callbacks = new ChatRateLimit(20);
  private stopped = false;
  private exchanging = 0;
  private readonly jwks: JWTVerifyGetKey;
  private readonly fetcher: TelegramFetch;
  private readonly authorizeUrl: string;

  constructor(private readonly config: AuthConfig, private readonly access: Pick<AccessControl, "isAllowed">, dependencies: TelegramAuthDependencies = {}) {
    this.jwks = dependencies.jwks ?? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), { timeoutDuration: 10_000 });
    this.fetcher = dependencies.fetch ?? fetch;
    this.authorizeUrl = dependencies.authorizeUrl ?? `${ISSUER}/auth`;
  }

  get available() { return !this.stopped && Boolean(this.config.WEB_PUBLIC_URL && this.config.WEB_TELEGRAM_CLIENT_ID && this.config.WEB_TELEGRAM_CLIENT_SECRET); }
  private credentials() {
    const { WEB_TELEGRAM_CLIENT_ID: clientId, WEB_TELEGRAM_CLIENT_SECRET: secret, WEB_PUBLIC_URL: origin } = this.config;
    if (this.stopped || !clientId || !secret || !origin) throw new WebHttpError(503, "Telegram sign-in is not configured.");
    return { clientId, secret, origin, redirectUri: `${origin}/api/auth/telegram/callback` };
  }
  private cookieName(kind: "session" | "login") {
    return `${this.config.WEB_PUBLIC_URL?.startsWith("https:") ? "__Host-" : ""}ai_tg_bot_chat_${kind}`;
  }
  private cookie(kind: "session" | "login", value: string, maxAge: number) {
    return `${this.cookieName(kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.config.WEB_PUBLIC_URL?.startsWith("https:") ? "; Secure" : ""}`;
  }
  private cookieValue(request: Request, kind: "session" | "login") {
    const name = `${this.cookieName(kind)}=`;
    const cookies = (request.headers.get("Cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(name));
    if (cookies.length !== 1) return undefined;
    const value = cookies[0]!.slice(name.length);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.sessions) if (entry.expires <= now) this.sessions.delete(key);
    for (const [key, entry] of this.transactions) if (entry.expires <= now) this.transactions.delete(key);
  }
  isAdmin(userId: number) { return this.config.WEB_ADMIN_USER_IDS.includes(userId); }
  async userId(request: Request) {
    if (!this.available) return undefined;
    const value = this.cookieValue(request, "session");
    const sessionKey = value ? key(value) : undefined;
    const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
    if (!session || session.expires <= Date.now() || (!this.isAdmin(session.userId) && !await this.access.isAllowed(session.userId))) {
      if (sessionKey) this.sessions.delete(sessionKey);
      return undefined;
    }
    return session.userId;
  }
  async requireSession(request: Request) {
    const userId = await this.userId(request);
    if (userId === undefined) throw new WebHttpError(401, "Sign in with Telegram to continue.");
    return userId;
  }
  start(request: Request, address = "unknown") {
    const { clientId, redirectUri } = this.credentials();
    this.starts.take(address);
    this.globalStarts.take("all");
    this.prune();
    const previous = this.cookieValue(request, "login");
    if (previous) for (const [key, transaction] of this.transactions) if (equal(transaction.browser, previous)) this.transactions.delete(key);
    if (this.transactions.size >= MAX_ENTRIES) throw new WebHttpError(503, "Sign-in is busy. Try again shortly.");
    const state = token();
    const browser = token();
    const verifier = token();
    const nonce = token();
    const requested = new URL(request.url).searchParams.get("return") ?? "/";
    const returnTo = RETURN_PATHS.has(requested) ? requested : "/";
    this.transactions.set(key(state), { browser, verifier, nonce, returnTo, expires: Date.now() + TRANSACTION_MS });
    const location = new URL(this.authorizeUrl);
    location.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid profile",
      state, nonce, code_challenge: hash(verifier).toString("base64url"), code_challenge_method: "S256",
    }).toString();
    return new Response(null, { status: 302, headers: { Location: location.toString(), "Set-Cookie": this.cookie("login", browser, TRANSACTION_MS / 1_000) } });
  }
  async callback(request: Request, requireExistingUser: (userId: number) => Promise<unknown>, address = "unknown") {
    const { clientId, secret, redirectUri } = this.credentials();
    this.prune();
    const query = new URL(request.url).searchParams;
    const state = query.get("state");
    const code = query.get("code");
    const browser = this.cookieValue(request, "login");
    const transactionKey = state && /^[A-Za-z0-9_-]{43}$/.test(state) ? key(state) : undefined;
    const transaction = transactionKey ? this.transactions.get(transactionKey) : undefined;
    if (!transactionKey || !transaction || !browser || !equal(transaction.browser, browser)) throw new WebHttpError(400, "Sign-in expired or did not start in this browser. Try again.");
    this.callbacks.take(address);
    this.transactions.delete(transactionKey);
    if (query.getAll("state").length !== 1 || query.getAll("code").length !== 1 || query.has("error") || !code || code.length > 4_096) {
      throw new WebHttpError(400, "Telegram sign-in was cancelled or is invalid. Try again.");
    }
    if (this.exchanging >= 16) throw new WebHttpError(503, "Sign-in is busy. Try again shortly.");
    this.exchanging++;
    let userId: number;
    try {
      const response = await this.fetcher(`${ISSUER}/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`, "utf8").toString("base64")}` },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: transaction.verifier }),
      });
      if (!response.ok) throw new Error("Token exchange failed");
      const result = TokenResponseSchema.parse(JSON.parse(await readBoundedBody(response, 65_536)));
      userId = await verifyTelegramIdentity(result.id_token, transaction.nonce, clientId, this.jwks);
    } catch {
      throw new WebHttpError(401, "Telegram sign-in could not be verified. Try again.");
    } finally { this.exchanging--; }
    if (!this.isAdmin(userId)) {
      if (!await this.access.isAllowed(userId)) throw new WebHttpError(403, "This Telegram account is not allowed to use this bot.");
      await requireExistingUser(userId);
      if (!await this.access.isAllowed(userId)) throw new WebHttpError(403, "This Telegram account is not allowed to use this bot.");
    }
    this.credentials();
    request.signal.throwIfAborted();
    this.prune();
    const previous = this.cookieValue(request, "session");
    if (previous) this.sessions.delete(key(previous));
    const existing = [...this.sessions].filter(([, session]) => session.userId === userId);
    for (const [sessionKey] of existing.slice(0, Math.max(0, existing.length - MAX_USER_SESSIONS + 1))) this.sessions.delete(sessionKey);
    if (this.sessions.size >= MAX_ENTRIES) throw new WebHttpError(503, "Sign-in is busy. Try again shortly.");
    const session = token();
    this.sessions.set(key(session), { userId, expires: Date.now() + SESSION_MS });
    const headers = new Headers({ Location: transaction.returnTo });
    headers.append("Set-Cookie", this.cookie("session", session, SESSION_MS / 1_000));
    headers.append("Set-Cookie", this.cookie("login", "", 0));
    return new Response(null, { status: 303, headers });
  }
  logout(request: Request) {
    const value = this.cookieValue(request, "session");
    if (value) this.sessions.delete(key(value));
    return this.cookie("session", "", 0);
  }
  revokeSessions(userId: number) {
    for (const [sessionKey, session] of this.sessions) if (session.userId === userId) this.sessions.delete(sessionKey);
  }
  clear() { this.stopped = true; this.sessions.clear(); this.transactions.clear(); this.starts.clear(); this.globalStarts.clear(); this.callbacks.clear(); }
}

/** Enforce limits on bytes actually received, including chunked bodies. */
export async function readBoundedBody(source: Request | Response, limit: number): Promise<string> {
  return (await readBoundedBytes(source, limit)).toString("utf8");
}
export async function readBoundedBytes(source: Request | Response, limit: number): Promise<Buffer> {
  const declared = Number(source.headers.get("Content-Length"));
  if (declared > limit) throw new WebHttpError(413, "Request is too large.");
  if (!source.body) return Buffer.alloc(0);
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 15_000);
  try {
    while (true) {
      const part = await reader.read();
      if (timedOut) throw new WebHttpError(408, "Request timed out.");
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        throw new WebHttpError(413, "Request is too large.");
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
