import { describe, expect, it } from "vitest";
import { canonicalTimeZone, describeUserTimeZone, formatUtcOffset, offsetFromLocalTime, parseLocalTime, userOffsetMinutes, zoneOffsetMinutes } from "../../src/bot/timezone.js";

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

  it("accepts IANA zone names in any case and rejects unknown ones", () => {
    expect(canonicalTimeZone(" america/los_angeles ")).toBe("America/Los_Angeles");
    expect(canonicalTimeZone("Europe/Moscow")).toBe("Europe/Moscow");
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeNull();
    expect(canonicalTimeZone("14:30")).toBeNull();
  });

  it("follows daylight saving and odd offsets for named zones", () => {
    expect(zoneOffsetMinutes("America/Los_Angeles", new Date("2026-07-01T12:00:00Z"))).toBe(-420);
    expect(zoneOffsetMinutes("America/Los_Angeles", new Date("2026-12-01T12:00:00Z"))).toBe(-480);
    expect(zoneOffsetMinutes("Asia/Kathmandu", new Date("2026-07-01T12:00:00Z"))).toBe(345);
    const winter = new Date("2026-12-01T12:00:00Z");
    expect(userOffsetMinutes({ tz_name: "America/Los_Angeles", tz_offset_min: -420 }, winter)).toBe(-480);
    expect(userOffsetMinutes({ tz_name: null, tz_offset_min: 180 }, winter)).toBe(180);
    expect(userOffsetMinutes({ tz_name: null, tz_offset_min: null }, winter)).toBeNull();
    expect(describeUserTimeZone({ tz_name: "America/Los_Angeles", tz_offset_min: -420 }, winter)).toBe("America/Los_Angeles (UTC-08:00)");
  });
});
