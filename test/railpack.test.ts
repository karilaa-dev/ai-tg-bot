import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Railpack deployment configuration", () => {
  it("contains only application-specific deployment settings", async () => {
    const config = JSON.parse(await fs.readFile("railpack.json", "utf8"));

    expect(config).toEqual({
      $schema: "https://schema.railpack.com",
      deploy: {
        startCommand: "node dist/src/main.js",
      },
    });
  });

  it("keeps all runtime assets in the Railpack build context", async () => {
    await expect(fs.access("locales/en.ftl")).resolves.toBeUndefined();
    await expect(fs.access("skills/officecli-docx/SKILL.md")).resolves.toBeUndefined();
    await expect(fs.access("system_prompt.md")).resolves.toBeUndefined();
  });
});
