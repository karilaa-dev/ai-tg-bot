import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUpgradeAuditEnvironmentOrFile } from "../../src/upgrade/environment.js";

describe("upgrade audit environment", () => {
  let tempDir: string;
  let secretFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-upgrade-environment-"));
    secretFile = path.join(tempDir, "secret");
    await fs.writeFile(secretFile, "postgresql://audit:secret@postgres/aibot\n");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lets DB_URL_FILE override only the inherited image default", () => {
    expect(readUpgradeAuditEnvironmentOrFile("DB_URL", {
      DB_URL: "sqlite:/app/data/bot.db",
      DB_URL_FILE: secretFile,
    })).toBe("postgresql://audit:secret@postgres/aibot");
  });

  it("rejects ambiguous explicit direct and file settings", () => {
    expect(() => readUpgradeAuditEnvironmentOrFile("DB_URL", {
      DB_URL: "postgresql://other:secret@postgres/aibot",
      DB_URL_FILE: secretFile,
    })).toThrow("Set only DB_URL or DB_URL_FILE, not both");
    expect(() => readUpgradeAuditEnvironmentOrFile("BOT_TOKEN", {
      BOT_TOKEN: "123:direct",
      BOT_TOKEN_FILE: secretFile,
    })).toThrow("Set only BOT_TOKEN or BOT_TOKEN_FILE, not both");
  });
});
