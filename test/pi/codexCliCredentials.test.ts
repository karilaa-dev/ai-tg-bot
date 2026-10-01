import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_PROVIDER_ID,
  CodexCliCredentialStore,
  discoverCodexCliCredentials,
  resolveCodexAuthFile,
} from "../../src/pi/codexCliCredentials.js";
import { deferred } from "../helpers/async.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("Codex CLI credentials", () => {
  it("discovers the standard cache without copying its OAuth tokens", async () => {
    const authFile = await writeAuthFile({
      access: jwt({ exp: 2_000_000_000, "https://api.openai.com/auth.chatgpt_account_id": "acct-1" }),
      refresh: "refresh-1",
    });

    const discovered = await discoverCodexCliCredentials({ authFile });
    expect(discovered.status).toBe("available");
    await expect(discovered.store?.read(CODEX_PROVIDER_ID)).resolves.toMatchObject({
      type: "oauth",
      refresh: "refresh-1",
      expires: 2_000_000_000_000,
      accountId: "acct-original",
    });
    await expect(discovered.store?.list()).resolves.toEqual([
      { providerId: CODEX_PROVIDER_ID, type: "oauth" },
    ]);
    await expect(discovered.store?.read("openrouter")).resolves.toBeUndefined();
  });

  it("persists refreshed OAuth tokens atomically while preserving Codex metadata", async () => {
    const authFile = await writeAuthFile({
      access: jwt({ exp: 2_000_000_000 }),
      refresh: "refresh-before",
    });
    const discovered = await discoverCodexCliCredentials({ authFile });
    const nextAccess = jwt({ exp: 2_000_003_600 });

    const result = await discovered.store?.modify(CODEX_PROVIDER_ID, async () => ({
      type: "oauth",
      access: nextAccess,
      refresh: "refresh-after",
      expires: 2_000_003_600_000,
      accountId: "acct-after",
    }));

    expect(result).toMatchObject({ access: nextAccess, refresh: "refresh-after" });
    const written = JSON.parse(await fs.readFile(authFile, "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      custom: "preserved",
      tokens: {
        access_token: nextAccess,
        refresh_token: "refresh-after",
        account_id: "acct-after",
        id_token: "id-token-preserved",
      },
    });
    expect(typeof written.last_refresh).toBe("string");
    expect((await fs.stat(authFile)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(authFile))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not erase the developer's Codex login when the runtime store logs out", async () => {
    const authFile = await writeAuthFile({
      access: jwt({ exp: 2_000_000_000 }),
      refresh: "refresh-1",
    });
    const discovered = await discoverCodexCliCredentials({ authFile });

    await discovered.store?.delete(CODEX_PROVIDER_ID);

    await expect(discovered.store?.read(CODEX_PROVIDER_ID)).resolves.toBeUndefined();
    const written = JSON.parse(await fs.readFile(authFile, "utf8")) as { tokens: { refresh_token: string } };
    expect(written.tokens.refresh_token).toBe("refresh-1");
  });

  it("distinguishes missing and malformed credential caches", async () => {
    const directory = await temporaryDirectory();
    const missing = path.join(directory, "missing.json");
    await expect(discoverCodexCliCredentials({ authFile: missing })).resolves.toMatchObject({ status: "missing" });

    const malformed = path.join(directory, "malformed.json");
    await fs.writeFile(malformed, "{not-json", { mode: 0o600 });
    await expect(discoverCodexCliCredentials({ authFile: malformed })).resolves.toMatchObject({ status: "invalid" });
  });

  it("resolves the default, tilde, relative, and absolute cache paths", () => {
    expect(resolveCodexAuthFile({ CODEX_AUTH_FILE: undefined }, "/users/bot"))
      .toBe("/users/bot/.codex/auth.json");
    expect(resolveCodexAuthFile({ CODEX_AUTH_FILE: "~/.auth/codex.json" }, "/users/bot"))
      .toBe("/users/bot/.auth/codex.json");
    expect(resolveCodexAuthFile({ CODEX_AUTH_FILE: "/run/secrets/codex.json" }, "/users/bot"))
      .toBe("/run/secrets/codex.json");
    expect(resolveCodexAuthFile({ CODEX_AUTH_FILE: "data/codex.json" }, "/users/bot"))
      .toBe(path.resolve("data/codex.json"));
  });

  it("commits login after an in-flight refresh so the previous account cannot overwrite it", async () => {
    const authFile = await writeAuthFile({ access: jwt({ exp: 2_000_000_000 }), refresh: "old-refresh" });
    const store = new CodexCliCredentialStore(authFile);
    const refreshResult = deferred<void>();
    const refreshing = vi.fn(async () => {
      await refreshResult.promise;
      return { type: "oauth" as const, access: jwt({ exp: 2_000_000_100 }), refresh: "old-refreshed", expires: 2_000_000_100_000 };
    });
    const refreshingTask = store.modify(CODEX_PROVIDER_ID, refreshing);
    await vi.waitFor(() => expect(refreshing).toHaveBeenCalledOnce());
    const newCredential = { type: "oauth" as const, access: jwt({ exp: 2_100_000_000 }), refresh: "new-account", expires: 2_100_000_000_000, accountId: "new-account-id" };
    const piAuthFile = path.join(path.dirname(authFile), "pi-auth.json");
    const savingTask = store.saveLogin(piAuthFile, newCredential);
    refreshResult.resolve();
    await Promise.all([refreshingTask, savingTask]);
    expect(await store.read(CODEX_PROVIDER_ID)).toEqual(newCredential);
    const saved = JSON.parse(await fs.readFile(piAuthFile, "utf8"));
    expect(saved[CODEX_PROVIDER_ID].refresh).toBe("new-account");
    const cli = JSON.parse(await fs.readFile(authFile, "utf8"));
    expect(cli.tokens.refresh_token).toBe("old-refreshed");
    expect(cli.tokens.id_token).toBe("id-token-preserved");
    expect(cli.custom).toBe("preserved");
  });

  it("preserves other Pi provider credentials while replacing its active Codex login", async () => {
    const directory = await temporaryDirectory();
    const authFile = path.join(directory, "pi-auth.json");
    const otherProvider = { type: "api_key", key: "existing-provider-secret" };
    await fs.writeFile(authFile, JSON.stringify({ other: otherProvider }));
    const store = new CodexCliCredentialStore(authFile, undefined, "pi");
    const newCredential = { type: "oauth" as const, access: jwt({ exp: 2_100_000_000 }), refresh: "new-account", expires: 2_100_000_000_000 };
    await store.saveLogin(authFile, newCredential);
    expect(await store.read(CODEX_PROVIDER_ID)).toEqual(newCredential);
    expect(JSON.parse(await fs.readFile(authFile, "utf8"))).toEqual({ other: otherProvider, [CODEX_PROVIDER_ID]: newCredential });
    expect((await fs.stat(authFile)).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous credential when login is cancelled while waiting for a refresh", async () => {
    const authFile = await writeAuthFile({ access: jwt({ exp: 2_000_000_000 }), refresh: "old-refresh" });
    const store = new CodexCliCredentialStore(authFile);
    const started = deferred<void>();
    const refreshing = deferred<void>();
    const refreshTask = store.modify(CODEX_PROVIDER_ID, async (current) => { started.resolve(); await refreshing.promise; return current; });
    await started.promise;
    const controller = new AbortController();
    const piAuthFile = path.join(path.dirname(authFile), "pi-auth.json");
    const saving = store.saveLogin(piAuthFile, { type: "oauth", access: "new", refresh: "new", expires: 1 }, controller.signal);
    const rejected = expect(saving).rejects.toThrow();
    controller.abort();
    await rejected;
    const next = vi.fn(async (current) => current);
    const nextTask = store.modify(CODEX_PROVIDER_ID, next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    refreshing.resolve();
    await Promise.all([refreshTask, nextTask]);
    expect(await store.read(CODEX_PROVIDER_ID)).toMatchObject({ refresh: "old-refresh" });
    await expect(fs.stat(piAuthFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeAuthFile(input: { access: string; refresh: string }): Promise<string> {
  const directory = await temporaryDirectory();
  const authFile = path.join(directory, "auth.json");
  await fs.writeFile(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id-token-preserved",
      access_token: input.access,
      refresh_token: input.refresh,
      account_id: "acct-original",
    },
    last_refresh: "2026-08-01T00:00:00.000Z",
    custom: "preserved",
  }), { mode: 0o600 });
  return authFile;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-codex-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}
