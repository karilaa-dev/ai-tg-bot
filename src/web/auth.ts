import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "ai_tg_bot_admin";
const SESSION_MS = 12 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_LOGIN_CLIENTS = 1_024;
const MAX_BODY_BYTES = 4_096;
const MAX_SESSIONS = 64;

export class WebHttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

/** Forwarding can only enable Secure, never downgrade an HTTPS request. */
function isHttps(request: Request) {
  return new URL(request.url).protocol === "https:" || request.headers.get("X-Forwarded-Proto")?.toLowerCase() === "https";
}

export function requireAdminMutation(request: Request) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (request.headers.get("X-Admin-Request") !== "1" || (site !== null && site !== "same-origin")) {
    throw new WebHttpError(403, "This action must come from this website.");
  }
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    const expected = new URL(request.url);
    if (isHttps(request)) expected.protocol = "https:";
    // Reverse proxies must preserve Host; forwarded host is not an authority for CSRF.
    if (origin !== expected.origin) throw new WebHttpError(403, "This action must come from this website.");
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class WebAdminAuth {
  private readonly tokenHash: Buffer;
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();

  constructor(token: string | undefined) {
    if (!token?.trim()) throw new Error("WEB_ADMIN_TOKEN must be set when the website is enabled.");
    if (Buffer.byteLength(token) > 1_024) throw new Error("WEB_ADMIN_TOKEN must not exceed 1024 bytes.");
    this.tokenHash = digest(token);
  }

  private sessionKey(request: Request) {
    const values = (request.headers.get("Cookie") ?? "").split(";")
      .map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(`${COOKIE_NAME}=`));
    if (values.length !== 1) return undefined;
    const value = values[0]!.slice(COOKIE_NAME.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? digest(value).toString("hex") : undefined;
  }

  authenticated(request: Request) {
    const key = this.sessionKey(request);
    if (!key) return false;
    const expires = this.sessions.get(key);
    if (expires === undefined) return false;
    if (expires <= Date.now()) { this.sessions.delete(key); return false; }
    return true;
  }

  requireSession(request: Request) {
    if (!this.authenticated(request)) throw new WebHttpError(401, "Sign in with the admin token to continue.");
  }

  async login(request: Request, clientAddress = "unknown") {
    const body = await readLoginBody(request);
    const now = Date.now();
    if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
      throw new WebHttpError(400, "Enter an admin token.");
    }
    for (const [client, times] of this.attempts) {
      const recent = times.filter(time => time > now - LOGIN_WINDOW_MS);
      if (recent.length) this.attempts.set(client, recent);
      else this.attempts.delete(client);
    }
    const attempts = this.attempts.get(clientAddress) ?? [];
    // Throttle before checking the token: checking first still permits unlimited
    // guesses, even if incorrect guesses receive 429. Existing sessions stay valid.
    if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
      const retry = Math.max(1, Math.ceil((attempts[0]! + LOGIN_WINDOW_MS - now) / 1_000));
      throw new WebHttpError(429, "Too many sign-in attempts. Try again in a minute.", { "Retry-After": String(retry) });
    }
    if (!timingSafeEqual(digest(body.token), this.tokenHash)) {
      if (!this.attempts.has(clientAddress) && this.attempts.size >= MAX_LOGIN_CLIENTS) {
        this.attempts.delete(this.attempts.keys().next().value!);
      }
      attempts.push(now);
      this.attempts.set(clientAddress, attempts);
      throw new WebHttpError(401, "The admin token is incorrect.");
    }
    // Replace this browser's previous session; other signed-in browsers remain valid.
    const previous = this.sessionKey(request);
    if (previous) this.sessions.delete(previous);
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(digest(session).toString("hex"), now + SESSION_MS);
    return this.cookie(request, session, SESSION_MS / 1_000);
  }

  logout(request: Request) {
    const key = this.sessionKey(request);
    if (key) this.sessions.delete(key);
    return this.cookie(request, "", 0);
  }

  clear() { this.sessions.clear(); this.attempts.clear(); }

  private cookie(request: Request, value: string, maxAge: number) {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(request) ? "; Secure" : ""}`;
  }
}

async function readLoginBody(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new WebHttpError(415, "Send the admin token as JSON.");
  }
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_BODY_BYTES) throw new WebHttpError(413, "Sign-in request is too large.");
  if (!request.body) throw new WebHttpError(400, "Enter an admin token.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 10_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (timedOut) throw new WebHttpError(408, "Sign-in request timed out.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new WebHttpError(413, "Sign-in request is too large.");
      }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new WebHttpError(400, "Invalid sign-in request."); }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
