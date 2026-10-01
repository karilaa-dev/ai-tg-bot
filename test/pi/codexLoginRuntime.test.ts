import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { PiRuntimeManager } from "../../src/pi/runtime.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("Codex login runtime activation", () => {
  it("enables Codex on the existing runtime after an initially missing login, and reopens the circuit for a new account", async () => {
    const { manager, authFile, piAuthFile } = await setup();
    expect(await manager.codexCredentialStatus()).toBe("missing");
    expect(manager.providerRouter.codexConfigured()).toBe(false);
    const registry = manager.modelRegistry;
    const runtime = manager.modelRuntime;
    const router = manager.providerRouter;
    await manager.saveCodexCredentials(credential("first"));
    expect(manager.modelRegistry).toBe(registry);
    expect(manager.modelRuntime).toBe(runtime);
    expect(manager.providerRouter).toBe(router);
    expect(router.codexConfigured()).toBe(true);
    expect(await registry.getApiKeyAndHeaders(router.codexModel("main"))).toMatchObject({ ok: true, apiKey: credential("first").access });
    const failure = router.circuit.acquire();
    if (!failure.allowed) throw new Error("Expected a Codex attempt.");
    failure.recordFailure();
    expect(router.circuit.state().open).toBe(true);
    await manager.saveCodexCredentials(credential("second"));
    expect(router.circuit.state().open).toBe(false);
    const obsolete = router.circuit.acquire();
    if (!obsolete.allowed) throw new Error("Expected a Codex attempt.");
    await manager.saveCodexCredentials(credential("third"));
    obsolete.recordFailure();
    expect(router.circuit.state().open).toBe(false);
    expect(await registry.getApiKeyAndHeaders(router.codexModel("main"))).toMatchObject({ ok: true, apiKey: credential("third").access });
    expect(JSON.parse(await fs.readFile(piAuthFile, "utf8"))["openai-codex"].refresh).toBe("refresh-third");
    await expect(fs.stat(authFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Pi credential precedence and updates that active source without touching the separate CLI login", async () => {
    const { manager, authFile, piAuthFile } = await setup(true);
    const cliBefore = await fs.readFile(authFile, "utf8");
    expect(await manager.codexCredentialStatus()).toBe("available");
    expect((await manager.modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe(credential("pi-original").access);
    await manager.saveCodexCredentials(credential("replacement"));
    expect((await manager.modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe(credential("replacement").access);
    expect(JSON.parse(await fs.readFile(piAuthFile, "utf8"))).toMatchObject({
      "openai-codex": credential("replacement"),
      "other-provider": { type: "api_key", key: "other-secret" },
    });
    expect(await fs.readFile(authFile, "utf8")).toBe(cliBefore);
  });

  it("switches an existing CLI-backed runtime to bot-owned credentials without changing the CLI cache", async () => {
    const { manager, authFile, piAuthFile } = await setup(false, true);
    const cliBefore = await fs.readFile(authFile, "utf8");
    expect((await manager.modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe(credential("cli").access);
    await manager.saveCodexCredentials(credential("web-login"));
    expect((await manager.modelRuntime.getAuth("openai-codex"))?.auth.apiKey).toBe(credential("web-login").access);
    expect(await fs.readFile(authFile, "utf8")).toBe(cliBefore);
    expect(JSON.parse(await fs.readFile(piAuthFile, "utf8"))["openai-codex"]).toEqual(credential("web-login"));
  });
});

async function setup(pi = false, cliOnly = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, "custom", "codex-auth.json");
  const agentDir = path.join(directory, "pi");
  const piAuthFile = path.join(agentDir, "auth.json");
  if (pi) {
    await fs.mkdir(agentDir);
    await fs.writeFile(piAuthFile, JSON.stringify({ "openai-codex": credential("pi-original"), "other-provider": { type: "api_key", key: "other-secret" } }));
  }
  if (pi || cliOnly) {
    await fs.mkdir(path.dirname(authFile));
    await fs.writeFile(authFile, JSON.stringify({ tokens: { id_token: "cli-id-token", access_token: credential("cli").access, refresh_token: "refresh-cli" } }));
  }
  const config = loadTestConfig({ PI_CODING_AGENT_DIR: agentDir, CODEX_AUTH_FILE: authFile, LOG_LEVEL: "error" });
  const manager = new PiRuntimeManager({ config, logger: createLogger(config), db: undefined as never, repos: undefined as never });
  await manager.initialize();
  cleanups.push(() => manager.dispose());
  return { manager, authFile, piAuthFile };
}

function credential(account: string): OAuthCredential {
  return {
    type: "oauth",
    access: `e30.${Buffer.from(JSON.stringify({ exp: 2_100_000_000, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`,
    refresh: `refresh-${account}`,
    expires: 2_100_000_000_000,
    accountId: account,
  };
}
