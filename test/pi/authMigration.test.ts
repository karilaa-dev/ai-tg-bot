import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { legacyCodexAuthCandidates, migrateLegacyCodexAuth } from "../../src/pi/authMigration.js";

describe("legacy Codex OAuth migration", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("backs up and converts an in-place Codex CLI auth file exactly once", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-auth-"));
    const agentDir = path.join(tempDir, "pi");
    await fs.mkdir(agentDir, { recursive: true });
    const access = jwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
    });
    const legacy = {
      auth_mode: "chatgpt",
      tokens: { access_token: access, refresh_token: "refresh-token", account_id: "acct-explicit" },
    };
    await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(legacy));

    const logger = createLogger(loadTestConfig());
    const first = await migrateLegacyCodexAuth({ agentDir, logger });
    expect(first).toMatchObject({ migrated: true, source: path.join(agentDir, "auth.json") });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "auth.codex-cli.json"), "utf8"))).toEqual(legacy);
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"))).toEqual({
      "openai-codex": {
        type: "oauth",
        access,
        refresh: "refresh-token",
        expires: 2_000_000_000_000,
        accountId: "acct-explicit",
      },
    });

    expect(await migrateLegacyCodexAuth({ agentDir, logger })).toEqual({ migrated: false });
  });

  it("imports the old Unraid location without discarding existing Pi credentials", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-auth-unraid-"));
    const agentDir = path.join(tempDir, "pi");
    const legacyDir = path.join(tempDir, "codex");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
      openrouter: { type: "api_key", key: "existing-key" },
    }));
    await fs.writeFile(path.join(legacyDir, "auth.json"), JSON.stringify({
      tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-token" },
    }));

    const logger = createLogger(loadTestConfig());
    const candidates = legacyCodexAuthCandidates(agentDir, {});
    expect(candidates).toContain(path.join(legacyDir, "auth.json"));
    const result = await migrateLegacyCodexAuth({ agentDir, logger, legacyAuthPaths: candidates });
    expect(result).toMatchObject({ migrated: true, source: path.join(legacyDir, "auth.json") });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "auth.pre-pi.json"), "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "existing-key" },
    });
    const migrated = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    expect(migrated.openrouter).toEqual({ type: "api_key", key: "existing-key" });
    expect(migrated["openai-codex"]).toMatchObject({
      type: "oauth",
      refresh: "refresh-token",
      expires: 2_000_000_000_000,
    });
  });

  it("does not treat a corrupted Pi credential file as missing", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-auth-corrupt-"));
    const agentDir = path.join(tempDir, "pi");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "auth.json"), "{not-json");

    await expect(migrateLegacyCodexAuth({
      agentDir,
      logger: createLogger(loadTestConfig()),
    })).rejects.toThrow();
    expect(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")).toBe("{not-json");
  });
});

function jwt(payload: Record<string, unknown>): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}
