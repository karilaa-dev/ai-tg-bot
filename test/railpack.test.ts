import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Railpack deployment configuration", () => {
  it("uses the pinned Node runtime, deterministic install, and direct Node startup", async () => {
    const config = JSON.parse(await fs.readFile("railpack.json", "utf8"));

    expect(config.provider).toBe("node");
    expect(config.packages.node).toBe("24.18.0");
    expect(config.buildAptPackages).toEqual(["g++", "make", "python3"]);
    expect(config.steps.install.commands).toContain("npm ci");
    expect(config.deploy.startCommand).toBe("node dist/src/main.js");
    expect(config.deploy.aptPackages).toEqual([
      "ca-certificates",
      "gzip",
      "tar",
    ]);
    expect(config.deploy.inputs).toBeUndefined();
    expect(config.deploy.paths).toBeUndefined();
    expect(config.deploy.variables).toEqual({
      NODE_ENV: "production",
      DB_URL: "sqlite:/app/data/bot.db",
      PI_CODING_AGENT_DIR: "/app/data/pi",
    });
  });

  it("keeps all runtime assets in the Railpack build context", async () => {
    await expect(fs.access("locales/en.ftl")).resolves.toBeUndefined();
    await expect(fs.access("skills/officecli-docx/SKILL.md")).resolves.toBeUndefined();
    await expect(fs.access("system_prompt.md")).resolves.toBeUndefined();
  });
});
