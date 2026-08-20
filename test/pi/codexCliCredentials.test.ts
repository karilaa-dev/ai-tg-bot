import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_PROVIDER_ID,
  discoverCodexCliCredentials,
  resolveCodexAuthFile,
} from "../../src/pi/codexCliCredentials.js";

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
