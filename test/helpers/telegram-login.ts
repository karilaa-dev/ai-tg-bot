import { randomUUID } from "node:crypto";
import { serve } from "bun";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { TelegramAuthDependencies } from "../../src/web/chat-auth.js";
import type { ChatService } from "../../src/web/chat-types.js";

/** Website settings that turn on Telegram login; WEB_PUBLIC_URL only shapes cookies and the redirect URI. */
export const telegramLoginConfig = {
  WEB_TELEGRAM_CLIENT_ID: "123",
  WEB_TELEGRAM_CLIENT_SECRET: "test-client-secret",
  WEB_PUBLIC_URL: "https://chat.example",
} as const;

/** Enough of a chat service for sign-in, which only checks that the account has used the bot. */
export const signInOnlyChat = (botUsername = "test_bot") => ({
  service: { profile: async (id: number) => ({ id, name: `User ${id}`, username: null }) } as unknown as ChatService,
  botUsername,
});

export const sessionCookie = (response: Response) => setCookie(response, "ai_tg_bot_chat_session");

function setCookie(response: Response, name: string) {
  const value = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]!).find(cookie => cookie.replace(/^__Host-/, "").startsWith(`${name}=`));
  if (!value) throw new Error(`The response did not set ${name}.`);
  return value;
}

/** Stands in for Telegram's OAuth server: signs an ID token for whichever user the sign-in names. */
export async function fakeTelegramLogin() {
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" };
  const grants = new Map<string, { userId: number; nonce: string }>();
  const grant = (userId: number, nonce: string) => {
    const code = randomUUID();
    grants.set(code, { userId, nonce });
    return code;
  };
  const dependencies: TelegramAuthDependencies = {
    jwks: createLocalJWKSet({ keys: [jwk] }),
    fetch: async (_input, init) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const code = body.get("code") ?? "";
      const granted = grants.get(code);
      grants.delete(code);
      if (!granted) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ id_token: await new SignJWT({ id: granted.userId, nonce: granted.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://oauth.telegram.org").setAudience(body.get("client_id")!)
        .setSubject(`subject-${granted.userId}`).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey) });
    },
  };

  return {
    dependencies,
    /** Runs the redirect flow against a website and returns its session cookie. */
    async signIn(origin: URL | string, userId: number): Promise<string> {
      const start = await fetch(new URL("/api/auth/telegram/start", origin), { redirect: "manual" });
      if (start.status !== 302) throw new Error(`Telegram sign-in did not start (${start.status}).`);
      const location = new URL(start.headers.get("Location")!);
      const code = grant(userId, location.searchParams.get("nonce")!);
      const callback = new URL("/api/auth/telegram/callback", origin);
      callback.search = new URLSearchParams({ code, state: location.searchParams.get("state")! }).toString();
      const done = await fetch(callback, { redirect: "manual", headers: { Cookie: setCookie(start, "ai_tg_bot_chat_login") } });
      if (done.status !== 303) throw new Error(`Telegram sign-in failed (${done.status}): ${await done.text()}`);
      return sessionCookie(done);
    },
    /**
     * A local Telegram consent page that approves `userId` at once and returns to `website()`.
     * Pass its `authorizeUrl` in the dependencies so browsers can sign in without Telegram.
     */
    serveAuthorizePage(userId: number, website: () => URL, port = 0) {
      const server = serve({ hostname: "127.0.0.1", port, fetch: request => {
        const query = new URL(request.url).searchParams;
        const callback = new URL("/api/auth/telegram/callback", website());
        callback.search = new URLSearchParams({ code: grant(userId, query.get("nonce") ?? ""), state: query.get("state") ?? "" }).toString();
        return new Response(null, { status: 302, headers: { Location: callback.href } });
      } });
      return { authorizeUrl: new URL("/auth", server.url).href, stop: () => server.stop(true) };
    },
  };
}
