import { describe, expect, it } from "vitest";
import { disposableCamofoxUserId, interactiveCamofoxUserId } from "../../src/camofox/session.js";
import { loadTestConfig } from "../../src/config.js";

describe("Camofox session ownership", () => {
  const config = loadTestConfig();

  it("is stable within a thread and isolated across threads", () => {
    expect(interactiveCamofoxUserId(config, 10, 20)).toBe(interactiveCamofoxUserId(config, 10, 20));
    expect(interactiveCamofoxUserId(config, 10, 20)).not.toBe(interactiveCamofoxUserId(config, 10, 21));
    expect(interactiveCamofoxUserId(config, 10, 20)).not.toContain("10:20");
  });

  it("randomizes disposable sessions", () => {
    expect(disposableCamofoxUserId(config, 10, 20, "extract"))
      .not.toBe(disposableCamofoxUserId(config, 10, 20, "extract"));
  });
});
