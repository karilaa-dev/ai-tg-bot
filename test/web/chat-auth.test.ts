import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { chatClientAddress, verifyTelegramIdentity, WebChatAuth, readBoundedBody } from "../../src/web/chat-auth.js";

const config = { WEB_PUBLIC_URL: "https://chat.example", WEB_TELEGRAM_CLIENT_ID: "123", WEB_TELEGRAM_CLIENT_SECRET: "dedicated_secret-with_underscore", WEB_ADMIN_USER_IDS: [7] };
const access = { isAllowed: async (id: number) => id === 42 };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }] });
});
afterEach(() => vi.restoreAllMocks());
const signed = (claims: JWTPayload, signingKey = keys.privateKey) => new SignJWT({ iss: "https://oauth.telegram.org", aud: "123", sub: "opaque-not-a-telegram-id", nonce: "nonce", id: 42, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(signingKey);
const cookie = (response: Response, prefix = "__Host-ai_tg_bot_chat_login=") => response.headers.getSetCookie().find(value => value.startsWith(prefix))!.split(";")[0]!;
function begin(auth: WebChatAuth, previous?: string, query = "") {
  const response = auth.start(new Request(`https://chat.example/api/auth/telegram/start${query}`, { headers: previous ? { Cookie: previous } : {} }));
  return { response, location: new URL(response.headers.get("Location")!), cookie: cookie(response) };
}
function callback(start: ReturnType<typeof begin>, headers: Record<string, string> = {}, suffix = "") {
  return new Request(`https://chat.example/api/auth/telegram/callback?state=${start.location.searchParams.get("state")}&code=code${suffix}`, { headers: { Cookie: start.cookie, ...headers } });
}

describe("Telegram ID-token verification", () => {
  it("uses the verified numeric id, never the OIDC subject or username", async () => {
    expect(await verifyTelegramIdentity(await signed({ id: "42", sub: "9000", preferred_username: "another_user" }), "nonce", "123", jwks)).toBe(42);
    for (const id of [undefined, null, "0042", "nope", -1, 0, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(verifyTelegramIdentity(await signed({ id }), "nonce", "123", jwks)).rejects.toThrow();
    }
  });
  it("rejects bad signatures, issuer, audience, expiry, nonce, and missing mandatory claims", async () => {
    const wrong = await generateKeyPair("RS256");
    await expect(verifyTelegramIdentity(await signed({}, wrong.privateKey), "nonce", "123", jwks)).rejects.toThrow();
    for (const claims of [{ iss: "https://attacker.example" }, { aud: "456" }, { exp: 1 }, { nonce: "other" }, { nonce: undefined }, { exp: undefined }, { iat: undefined }, { iat: Math.floor(Date.now() / 1000) + 60 }, { sub: undefined }, { aud: ["123", "456"] }, { azp: "456" }]) {
      await expect(verifyTelegramIdentity(await signed(claims), "nonce", "123", jwks)).rejects.toThrow();
    }
    expect(await verifyTelegramIdentity(await signed({ aud: ["123", "456"], azp: "123" }), "nonce", "123", jwks)).toBe(42);
  });
});

it("completes S256 exchange using dedicated raw Basic credentials and revocable opaque sessions", async () => {
  let nonce = "";
  let verifier = "";
  const exchange = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(async (url, init) => {
    expect(url).toBe("https://oauth.telegram.org/token");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Basic ${Buffer.from(`123:${config.WEB_TELEGRAM_CLIENT_SECRET}`).toString("base64")}`);
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_id")).toBe("123");
    expect(form.get("redirect_uri")).toBe("https://chat.example/api/auth/telegram/callback");
    expect(form.get("grant_type")).toBe("authorization_code");
    verifier = form.get("code_verifier")!;
    return Response.json({ id_token: await signed({ nonce }) });
  });
  const auth = new WebChatAuth(config, access, { jwks, fetch: exchange });
  const start = begin(auth);
  nonce = start.location.searchParams.get("nonce")!;
  expect(start.location.origin).toBe("https://oauth.telegram.org");
  expect(start.location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start.location.searchParams.get("scope")).toBe("openid profile");
  expect(start.response.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax; Max-Age=600; Secure");
  const existing = vi.fn(async () => undefined);
  const complete = await auth.callback(callback(start), existing);
  expect(existing).toHaveBeenCalledWith(42);
  expect(complete.status).toBe(303);
  expect(complete.headers.get("Location")).toBe("/");
  expect(createHash("sha256").update(verifier).digest("base64url")).toBe(start.location.searchParams.get("code_challenge"));
  const sessionCookie = cookie(complete, "__Host-ai_tg_bot_chat_session=");
  expect(complete.headers.getSetCookie().find(value => value.startsWith(sessionCookie))).toContain("Max-Age=43200; Secure");
  const request = new Request("https://chat.example/api/chat/session", { headers: { Cookie: sessionCookie } });
  expect(await auth.requireSession(request)).toBe(42);
  expect(await auth.userId(new Request(request, { headers: { Cookie: `${sessionCookie}; ${sessionCookie}` } }))).toBeUndefined();
  expect(auth.logout(request)).toContain("Max-Age=0");
  expect(await auth.userId(request)).toBeUndefined();
  await expect(auth.callback(callback(start), existing)).rejects.toMatchObject({ status: 400 });
  expect(exchange).toHaveBeenCalledOnce();
});

it("returns to the admin page only when asked, and never to another site", async () => {
  let nonce = "";
  const auth = new WebChatAuth(config, access, { jwks, fetch: async () => Response.json({ id_token: await signed({ nonce }) }) });
  for (const [query, location] of [["?return=/admin", "/admin"], ["?return=//evil.example", "/"], ["?return=https://evil.example/admin", "/"], ["?return=/admin/../api", "/"], ["", "/"]] as const) {
    const start = begin(auth, undefined, query);
    nonce = start.location.searchParams.get("nonce")!;
    expect((await auth.callback(callback(start), async () => {})).headers.get("Location")).toBe(location);
  }
  expect(auth.isAdmin(7)).toBe(true);
  expect(auth.isAdmin(42)).toBe(false);
});

it("binds single-use transactions to the browser and rejects expired or duplicate state", async () => {
  const exchange = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
  const auth = new WebChatAuth(config, access, { jwks, fetch: exchange });
  const a = begin(auth);
  const b = begin(auth);
  for (const Cookie of ["", b.cookie, `${a.cookie}; ${a.cookie}`]) {
    await expect(auth.callback(callback(a, { Cookie }), async () => {})).rejects.toMatchObject({ status: 400 });
  }
  await expect(auth.callback(callback(a, {}, `&state=${a.location.searchParams.get("state")}`), async () => {})).rejects.toMatchObject({ status: 400 });
  expect(exchange).not.toHaveBeenCalled();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
  await expect(auth.callback(callback(b), async () => {})).rejects.toMatchObject({ status: 400 });
});

it("enforces the allowlist and existing-user policy before creating a session", async () => {
  for (const allowed of [[], [42], [99]]) {
    let nonce = "";
    const auth = new WebChatAuth(config, { isAllowed: async id => allowed.includes(id) }, { jwks, fetch: async () => Response.json({ id_token: await signed({ nonce }) }) });
    const start = begin(auth);
    nonce = start.location.searchParams.get("nonce")!;
    const existing = vi.fn(async () => { throw new Error("unknown user"); });
    await expect(auth.callback(callback(start), existing)).rejects.toThrow();
    expect(existing).toHaveBeenCalledTimes(allowed.includes(42) ? 1 : 0);
    expect(await auth.userId(callback(start))).toBeUndefined();
  }
});

it("expires sessions, replaces old browser sessions and clears them on shutdown", async () => {
  let nonce = "";
  const auth = new WebChatAuth(config, access, { jwks, fetch: async () => Response.json({ id_token: await signed({ nonce }) }) });
  const signIn = async (previous?: string) => {
    const start = begin(auth, previous);
    nonce = start.location.searchParams.get("nonce")!;
    const result = await auth.callback(callback(start, { Cookie: [start.cookie, previous].filter(Boolean).join("; ") }), async () => {});
    return new Request("https://chat.example", { headers: { Cookie: cookie(result, "__Host-ai_tg_bot_chat_session=") } });
  };
  const first = await signIn();
  const second = await signIn(first.headers.get("Cookie")!);
  expect(await auth.userId(first)).toBeUndefined();
  expect(await auth.userId(second)).toBe(42);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 12 * 60 * 60_000);
  expect(await auth.userId(second)).toBeUndefined();
  clock.mockRestore();
  const third = await signIn();
  auth.clear();
  expect(await auth.userId(third)).toBeUndefined();
  expect(auth.available).toBe(false);
});

it("rejects OAuth errors returned with HTTP 200 and rate-limits start attempts", async () => {
  const auth = new WebChatAuth(config, access, { jwks, fetch: async () => Response.json({ error: "invalid_client" }) });
  const start = begin(auth);
  await expect(auth.callback(callback(start), async () => {})).rejects.toMatchObject({ status: 401 });
  for (let i = 0; i < 9; i++) begin(auth);
  expect(() => begin(auth)).toThrow("Too many requests");
});

it("keeps invalid callbacks from consuming a legitimate browser's exchange budget", async () => {
  let nonce = "";
  const auth = new WebChatAuth(config, access, { jwks, fetch: async () => Response.json({ id_token: await signed({ nonce }) }) });
  const start = begin(auth);
  nonce = start.location.searchParams.get("nonce")!;
  for (let i = 0; i < 30; i++) {
    await expect(auth.callback(new Request("https://chat.example/api/auth/telegram/callback?state=invalid&code=invalid"), async () => {})).rejects.toMatchObject({ status: 400 });
  }
  expect((await auth.callback(callback(start), async () => {})).status).toBe(303);
});

it("bounds sessions per verified account even when the browser discards its cookie", async () => {
  let nonce = "";
  const auth = new WebChatAuth(config, access, { jwks, fetch: async () => Response.json({ id_token: await signed({ nonce }) }) });
  const sessions: Request[] = [];
  for (let i = 0; i < 9; i++) {
    const start = begin(auth);
    nonce = start.location.searchParams.get("nonce")!;
    const result = await auth.callback(callback(start), async () => {});
    sessions.push(new Request("https://chat.example", { headers: { Cookie: cookie(result, "__Host-ai_tg_bot_chat_session=") } }));
  }
  expect(await auth.userId(sessions[0]!)).toBeUndefined();
  for (const request of sessions.slice(1)) expect(await auth.userId(request)).toBe(42);
});

it("only derives the client from forwarding headers behind explicitly trusted proxy hops", () => {
  const request = (value: string) => new Request("https://chat.example", { headers: { "X-Forwarded-For": value } });
  expect(chatClientAddress(request("203.0.113.1"), "192.0.2.10", [])).toBe("192.0.2.10");
  expect(chatClientAddress(request("203.0.113.1"), "192.0.2.10", ["192.0.2.10"])).toBe("203.0.113.1");
  expect(chatClientAddress(request("spoofed, 203.0.113.1"), "192.0.2.10", ["192.0.2.10"])).toBe("192.0.2.10");
  expect(chatClientAddress(request("203.0.113.99, 203.0.113.1, 192.0.2.11"), "192.0.2.10", ["192.0.2.10", "192.0.2.11"])).toBe("203.0.113.1");
});

it("bounds streamed request bodies even without Content-Length", async () => {
  const request = new Request("https://chat.example", { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.close(); } }) });
  await expect(readBoundedBody(request, 4)).rejects.toMatchObject({ status: 413 });
});
