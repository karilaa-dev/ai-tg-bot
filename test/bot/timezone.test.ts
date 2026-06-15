import { describe, expect, it } from "vitest";
import { formatUtcOffset, offsetFromLocalTime, parseLocalTime } from "../../src/bot/timezone.js";

describe("timezone parser", () => {
  it("parses 24h and 12h edges", () => {
    expect(parseLocalTime("14:30")).toEqual({ minutes: 870 });
    expect(parseLocalTime("12:00 AM")).toEqual({ minutes: 0 });
    expect(parseLocalTime("12:00 PM")).toEqual({ minutes: 720 });
    expect(parseLocalTime("24:00")).toBeNull();
  });

  it("rounds offset to 15 minutes", () => {
    const now = new Date("2026-06-13T12:07:00Z");
    expect(offsetFromLocalTime("05:00", now)).toBe(-420);
    expect(formatUtcOffset(-420)).toBe("UTC-07:00");
  });
});
