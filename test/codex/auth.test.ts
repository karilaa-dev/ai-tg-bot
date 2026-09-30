import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexAuth } from "../../src/codex/auth.js";
import type { Logger } from "../../src/logger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

function jwt(payload: unknown): string { return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`; }
function nativeAuth(refresh = "native-refresh"): Record<string, unknown> {
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {
    id_token: jwt({ email: "test@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "account-1", chatgpt_plan_type: "pro" } }),
    access_token: jwt({ exp: 2_000_000_000 }), refresh_token: refresh, account_id: "account-1",
  }, last_refresh: "2026-09-01T00:00:00Z" };
}
function piAuth(refresh = "pi-refresh"): Record<string, unknown> {
  return { "openai-codex": { type: "oauth", access: jwt({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "account-1", chatgpt_plan_type: "pro" } }), refresh, expires: 2_000_000_000_000, accountId: "account-1" }, openrouter: { type: "api_key", key: "keep-this" } };
}
async function write(file: string, document: unknown, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(document), { mode });
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-codex-auth-"));
  roots.push(root);
  const homeDirectory = path.join(root, "user");
  const config = { CODEX_HOME: path.join(root, "codex"), PI_CODING_AGENT_DIR: path.join(root, "pi"), CODEX_AUTH_FILE: undefined as string | undefined };
  return { root, homeDirectory, config, destination: path.join(config.CODEX_HOME, "auth.json"), piFile: path.join(config.PI_CODING_AGENT_DIR, "auth.json"), cliFile: path.join(homeDirectory, ".codex", "auth.json") };
}
async function read(file: string): Promise<Record<string, unknown>> { return JSON.parse(await fs.readFile(file, "utf8")); }

describe("native Codex authentication preparation", () => {
  it("creates a private Codex home and leaves missing authentication available for fallback", async () => {
    const input = await setup();
    expect(await prepareCodexAuth(input)).toEqual({ home: input.config.CODEX_HOME, configured: false });
    expect((await fs.stat(input.config.CODEX_HOME)).mode & 0o777).toBe(0o700);
    await expect(fs.stat(input.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps existing native home credentials ahead of older Pi and CLI credentials", async () => {
    const input = await setup();
    await write(input.destination, nativeAuth("newer-refresh"), 0o644);
    await write(input.piFile, piAuth("stale-pi"));
    await write(input.cliFile, nativeAuth("stale-cli"));
    expect((await prepareCodexAuth(input)).configured).toBe(true);
    expect(await read(input.destination)).toEqual(nativeAuth("newer-refresh"));
    expect((await fs.stat(input.destination)).mode & 0o777).toBe(0o600);
  });

  it("migrates Pi OAuth once, preserving the original and allowing native refresh", async () => {
    const input = await setup();
    const original = piAuth();
    await write(input.piFile, original);
    await write(input.cliFile, nativeAuth("other-login"));
    expect((await prepareCodexAuth(input)).configured).toBe(true);
    const converted = await read(input.destination);
    const credential = original["openai-codex"] as Record<string, unknown>;
    expect(converted).toMatchObject({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: credential.access, access_token: credential.access, refresh_token: credential.refresh, account_id: credential.accountId } });
    expect(typeof converted.last_refresh).toBe("string");
    expect(await read(input.piFile)).toEqual(original);
    expect((await fs.stat(input.destination)).mode & 0o777).toBe(0o600);
    await write(input.destination, nativeAuth("refreshed-by-codex"));
    await prepareCodexAuth(input);
    expect(await read(input.destination)).toEqual(nativeAuth("refreshed-by-codex"));
    expect(await read(input.piFile)).toEqual(original);
  });

  it("retains Pi's original ID token if it was stored", async () => {
    const input = await setup();
    const document = piAuth();
    const idToken = jwt({ email: "test@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
    (document["openai-codex"] as Record<string, unknown>).idToken = idToken;
    await write(input.piFile, document);
    await prepareCodexAuth(input);
    expect(await read(input.destination)).toMatchObject({ tokens: { id_token: idToken } });
  });

  it("links the CLI auth store so native refresh is persisted into the same authoritative file", async () => {
    const input = await setup();
    await write(input.cliFile, nativeAuth());
    expect((await prepareCodexAuth(input)).configured).toBe(true);
    expect((await fs.lstat(input.destination)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(input.destination)).toBe(await fs.realpath(input.cliFile));
    // The pinned native writer opens/truncates rather than replacing auth.json.
    await fs.writeFile(input.destination, JSON.stringify(nativeAuth("rotated")));
    expect(await read(input.cliFile)).toEqual(nativeAuth("rotated"));
  });

  it("honors the explicit auth source and preserves a displaced home login as a private backup", async () => {
    const input = await setup();
    const selected = path.join(input.root, "selected.json");
    await write(selected, nativeAuth("explicit"));
    await write(input.destination, nativeAuth("home-login"));
    await write(input.piFile, piAuth());
    input.config.CODEX_AUTH_FILE = selected;
    await prepareCodexAuth(input);
    expect(await read(input.destination)).toEqual(nativeAuth("explicit"));
    const backups = (await fs.readdir(input.config.CODEX_HOME)).filter(file => file.includes(".pre-v3."));
    expect(backups).toHaveLength(1);
    expect(await read(path.join(input.config.CODEX_HOME, backups[0]!))).toEqual(nativeAuth("home-login"));
    expect((await fs.stat(input.config.CODEX_HOME)).mode & 0o777).toBe(0o700);
  });

  it("does not overwrite native refreshed credentials with an unchanged readonly source on restart", async () => {
    const input = await setup();
    const source = path.join(input.root, "readonly.json");
    await write(source, nativeAuth("original"), 0o400);
    input.config.CODEX_AUTH_FILE = source;
    await prepareCodexAuth(input);
    expect((await fs.lstat(input.destination)).isSymbolicLink()).toBe(false);
    await write(input.destination, nativeAuth("native-rotation"));
    await prepareCodexAuth(input);
    expect(await read(input.destination)).toEqual(nativeAuth("native-rotation"));
    expect(await read(source)).toEqual(nativeAuth("original"));
    const marker = await fs.readFile(path.join(input.config.CODEX_HOME, "auth-source.json"), "utf8");
    expect(marker).not.toContain("original");
    expect(marker).not.toContain("native-rotation");
    expect((await fs.stat(path.join(input.config.CODEX_HOME, "auth-source.json"))).mode & 0o777).toBe(0o600);
    await fs.chmod(source, 0o600);
    await write(source, nativeAuth("new-authoritative-login"));
    await fs.chmod(source, 0o400);
    await prepareCodexAuth(input);
    expect(await read(input.destination)).toEqual(nativeAuth("new-authoritative-login"));
  });

  it("handles missing or invalid explicitly selected credentials without using a different login", async () => {
    const input = await setup();
    await write(input.destination, nativeAuth());
    input.config.CODEX_AUTH_FILE = path.join(input.root, "missing.json");
    expect((await prepareCodexAuth(input)).configured).toBe(false);
    expect(await read(input.destination)).toEqual(nativeAuth());
    await write(input.config.CODEX_AUTH_FILE, { tokens: { access_token: "secret-access", refresh_token: "secret-refresh" } });
    const warn = vi.fn();
    expect((await prepareCodexAuth({ ...input, logger: { warn } as unknown as Logger })).configured).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-access");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-refresh");
  });

  it("rejects malformed Pi OAuth and inconsistent account claims", async () => {
    for (const patch of [{ access: "not-a-jwt" }, { expires: 0 }, { refresh: "" }, { accountId: "wrong-account" }, { idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "wrong-account" } }) }]) {
      const input = await setup();
      const document = piAuth();
      Object.assign(document["openai-codex"] as Record<string, unknown>, patch);
      await write(input.piFile, document);
      expect((await prepareCodexAuth(input)).configured).toBe(false);
      expect(await read(input.piFile)).toEqual(document);
    }
  });

  it("accepts expired Pi access tokens with usable refresh credentials", async () => {
    const input = await setup();
    const document = piAuth();
    Object.assign(document["openai-codex"] as Record<string, unknown>, { access: jwt({ exp: 1, "https://api.openai.com/auth.chatgpt_account_id": "account-1" }), expires: 1000 });
    await write(input.piFile, document);
    expect((await prepareCodexAuth(input)).configured).toBe(true);
  });

  it("expands configured home-relative paths and serializes concurrent preparations", async () => {
    const input = await setup();
    input.config.CODEX_HOME = "~/bot-codex";
    input.config.CODEX_AUTH_FILE = "~/.codex/auth.json";
    await write(input.cliFile, nativeAuth());
    const results = await Promise.all([prepareCodexAuth(input), prepareCodexAuth(input), prepareCodexAuth(input)]);
    expect(results).toEqual(Array(3).fill({ home: path.join(input.homeDirectory, "bot-codex"), configured: true }));
    expect((await fs.readdir(results[0]!.home)).filter(file => file.endsWith(".bak") || file.endsWith(".tmp"))).toEqual([]);
  });
});
