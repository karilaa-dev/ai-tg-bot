import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCliCredentialStore } from "../../src/pi/codexCliCredentials.js";
import { CodexLoginManager } from "../../src/web/codex-login.js";
import { deferred } from "../helpers/async.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Codex device login", () => {
  it("uses the real SDK device flow and atomically creates the bot's native auth file", async () => {
    const authFile = await temporaryAuthFile();
    const store = new CodexCliCredentialStore(authFile, undefined, "pi");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "private-device-id", user_code: "ABCD-EFGH", interval: 0 });
      }
      if (url.endsWith("/deviceauth/token")) {
        expect(JSON.parse(String(init.body))).toEqual({ device_auth_id: "private-device-id", user_code: "ABCD-EFGH" });
        return Response.json({ authorization_code: "private-authorization-code", code_verifier: "private-verifier" });
      }
      expect(url).toBe("https://auth.openai.com/oauth/token");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
      expect(body.get("code_verifier")).toBe("private-verifier");
      return Response.json({ access_token: credential().access, refresh_token: credential().refresh, expires_in: 3600 });
    }));
    const manager = new CodexLoginManager({
      credentialStatus: () => store.status(),
      saveCredential: (credential, signal) => store.saveLogin(authFile, credential, signal),
    });
    cleanups.push(() => manager.stop());
    await manager.start();
    await vi.waitFor(async () => expect(await manager.status()).toMatchObject({ credentialStatus: "available", login: { status: "success" } }));
    expect(urls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    const stored = JSON.parse(await fs.readFile(authFile, "utf8"));
    expect(stored).toMatchObject({ "openai-codex": { access: credential().access, refresh: "private-refresh", accountId: "account-new" } });
    expect((await fs.stat(authFile)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await manager.status())).not.toMatch(/private-|account-new|access_token/);
  });

  it("shares one pending login and preserves previous credentials on cancellation and late completion", async () => {
    const authFile = await temporaryAuthFile();
    const store = new CodexCliCredentialStore(authFile, undefined, "pi");
    await store.saveLogin(authFile, credential("old"));
    const previous = await fs.readFile(authFile, "utf8");
    const oauth = deferred<OAuthCredential>();
    const login = vi.fn(async (interaction: ProviderAuthInteraction) => {
      expect(await interaction.prompt({ type: "select", message: "Login", options: [{ id: "device_code", label: "Device" }] })).toBe("device_code");
      interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device", expiresInSeconds: 900 });
      return oauth.promise;
    });
    const manager = new CodexLoginManager({ credentialStatus: () => store.status(), saveCredential: (value, signal) => store.saveLogin(authFile, value, signal), login });
    cleanups.push(() => manager.stop());
    await Promise.all([manager.start(), manager.start(), manager.start()]);
    await vi.waitFor(async () => expect((await manager.status()).login).toMatchObject({ status: "pending", userCode: "ABCD-EFGH" }));
    expect(login).toHaveBeenCalledOnce();
    expect(await fs.readFile(authFile, "utf8")).toBe(previous);
    expect((await manager.cancel()).login).toEqual({ status: "cancelled" });
    oauth.resolve(credential());
    await Promise.resolve();
    expect(await fs.readFile(authFile, "utf8")).toBe(previous);
    expect((await manager.status()).login).toEqual({ status: "cancelled" });
  });

  it("expires a stalled code and startup request without exposing provider errors", async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const login = vi.fn(async (interaction: ProviderAuthInteraction) => {
      interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device", expiresInSeconds: 5 });
      return new Promise<OAuthCredential>(() => {});
    });
    const manager = new CodexLoginManager({ credentialStatus: async () => "missing", saveCredential: save, login });
    cleanups.push(() => manager.stop());
    await manager.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await manager.status()).login).toEqual({ status: "expired", error: expect.any(String) });
    expect(save).not.toHaveBeenCalled();
    login.mockImplementation(async () => new Promise<OAuthCredential>(() => {}));
    await manager.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await manager.status()).login.status).toBe("expired");
    login.mockRejectedValue(new Error("access_token=private-access refresh_token=private-refresh"));
    await manager.start();
    await vi.runAllTimersAsync();
    expect((await manager.status()).login.status).toBe("error");
    expect(JSON.stringify(await manager.status())).not.toContain("private-");
  });

  it("reports persistence failure safely and permits a fresh login afterward", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("EACCES /private/path private-refresh")).mockResolvedValue(undefined);
    const manager = new CodexLoginManager({ credentialStatus: async () => "missing", saveCredential: save, login: async () => credential() });
    cleanups.push(() => manager.stop());
    await manager.start();
    await vi.waitFor(async () => expect((await manager.status()).login.status).toBe("error"));
    expect(JSON.stringify(await manager.status())).not.toMatch(/private-|EACCES/);
    await manager.start();
    await vi.waitFor(async () => expect((await manager.status()).login.status).toBe("success"));
  });

  it("waits for a credential commit on cancellation and prevents new logins after shutdown", async () => {
    const commit = deferred<void>();
    const save = vi.fn(() => commit.promise);
    const manager = new CodexLoginManager({ credentialStatus: async () => "available", saveCredential: save, login: async () => credential() });
    await manager.start();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const cancelled = manager.cancel();
    commit.resolve();
    expect((await cancelled).login.status).toBe("success");
    await manager.stop();
    await expect(manager.start()).rejects.toThrow("stopping");
  });

  it("bounds shutdown while a credential commit is waiting for an old refresh", async () => {
    vi.useFakeTimers();
    let commitSignal: AbortSignal | undefined;
    const manager = new CodexLoginManager({
      credentialStatus: async () => "available",
      saveCredential: async (_credential, signal) => { commitSignal = signal; return new Promise<void>(() => {}); },
      login: async () => credential(),
    });
    await manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(commitSignal?.aborted).toBe(false);
    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopping;
    expect(commitSignal?.aborted).toBe(true);
    expect((await manager.status()).login.status).toBe("error");
  });

  it("rejects unexpected verification links without saving credentials", async () => {
    const save = vi.fn();
    const manager = new CodexLoginManager({
      credentialStatus: async () => "missing", saveCredential: save,
      login: async (interaction) => {
        interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.com/phishing" });
        return credential();
      },
    });
    cleanups.push(() => manager.stop());
    await manager.start();
    await vi.waitFor(async () => expect((await manager.status()).login.status).toBe("error"));
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(await manager.status())).not.toContain("example.com");
  });
});

async function temporaryAuthFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-login-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "nested", "custom-auth.json");
}

function credential(account = "new"): OAuthCredential {
  return {
    type: "oauth",
    access: `e30.${Buffer.from(JSON.stringify({ exp: 2_100_000_000, "https://api.openai.com/auth": { chatgpt_account_id: `account-${account}` } })).toString("base64url")}.signature`,
    refresh: "private-refresh",
    expires: 2_100_000_000_000,
    accountId: `account-${account}`,
  };
}
