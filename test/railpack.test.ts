import { constants } from "node:fs";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Railpack deployment configuration", () => {
  it("uses the pinned Node runtime, deterministic install, and hardened entrypoint", async () => {
    const config = JSON.parse(await fs.readFile("railpack.json", "utf8"));

    expect(config.provider).toBe("node");
    expect(config.packages.node).toBe("24.18.0");
    expect(config.buildAptPackages).toEqual(expect.arrayContaining(["...", "g++", "make", "python3"]));
    expect(config.steps.install.commands).toContain("npm ci");
    expect(config.deploy.startCommand).toBe("tini -- ./docker/entrypoint.sh");
    expect(config.deploy.aptPackages).toEqual(expect.arrayContaining(["tini", "util-linux"]));
    expect(config.deploy.variables).toMatchObject({
      APP_DATA_ROOT: "/app/data",
      PI_CODING_AGENT_DIR: "/app/data/pi",
    });
  });

  it("keeps all runtime assets in the Railpack build context", async () => {
    await expect(fs.access("docker/entrypoint.sh", constants.X_OK)).resolves.toBeUndefined();
    await expect(fs.access("locales/en.ftl")).resolves.toBeUndefined();
    await expect(fs.access("skills/officecli-docx/SKILL.md")).resolves.toBeUndefined();
    await expect(fs.access("system_prompt.md")).resolves.toBeUndefined();
  });
});
