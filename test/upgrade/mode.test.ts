import { describe, expect, it } from "vitest";
import { assertTelegramStartupAllowed } from "../../src/upgrade/mode.js";

describe("upgrade startup mode", () => {
  it("allows normal startup only when upgrade mode is unset", () => {
    expect(() => assertTelegramStartupAllowed({})).not.toThrow();
    expect(() => assertTelegramStartupAllowed({ UPGRADE_MODE: "import" }))
      .toThrow("Telegram startup is disabled");
    expect(() => assertTelegramStartupAllowed({ UPGRADE_MODE: "typo" }))
      .toThrow("must be unset or 'import'");
  });
});
