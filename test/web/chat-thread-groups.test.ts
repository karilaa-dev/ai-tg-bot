import { fixtureUuid } from "./uuid-fixtures.js";
import { describe, expect, it } from "vitest";
import { chatFormat, chatStrings } from "../../src/web/client/chat/strings.js";
import { groupLabel, groupThreads, recencyGroup } from "../../src/web/client/chat/thread-groups.js";

// Local time, so the calendar arithmetic matches what a visitor sees.
const now = new Date(2026, 9, 23, 15, 30).getTime();
const at = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month, day, hour).getTime();

describe("chat thread recency groups", () => {
  it("uses local calendar days for today, yesterday, the previous week, and the last 30 days", () => {
    expect(recencyGroup(at(9, 23, 0), now)).toEqual({ kind: "today" });
    expect(recencyGroup(now + 60_000, now)).toEqual({ kind: "today" });
    expect(recencyGroup(at(9, 22, 23), now)).toEqual({ kind: "yesterday" });
    expect(recencyGroup(at(9, 22, 0), now)).toEqual({ kind: "yesterday" });
    expect(recencyGroup(at(9, 21, 23), now)).toEqual({ kind: "week" });
    expect(recencyGroup(at(9, 16, 0), now)).toEqual({ kind: "week" });
    expect(recencyGroup(at(9, 15, 23), now)).toEqual({ kind: "month" });
    expect(recencyGroup(at(8, 23, 0), now)).toEqual({ kind: "month" });
    expect(recencyGroup(at(8, 22, 23), now)).toEqual({ kind: "calendar", year: 2026, month: 8 });
    expect(recencyGroup(at(11, 31, 12, 2025), now)).toEqual({ kind: "calendar", year: 2025, month: 11 });
  });

  it("orders groups newest first and keeps the incoming order inside each group", () => {
    const threads = [
      { id: fixtureUuid(1), lastActivity: at(9, 23, 9) },
      { id: fixtureUuid(2), lastActivity: at(6, 2) },
      { id: fixtureUuid(3), lastActivity: at(9, 23, 8) },
      { id: fixtureUuid(4), lastActivity: at(8, 1) },
      { id: fixtureUuid(5), lastActivity: at(9, 22) },
      { id: fixtureUuid(6), lastActivity: at(9, 1) },
      { id: fixtureUuid(7), lastActivity: at(10, 30, 12, 2025) },
    ];
    const groups = groupThreads(threads, now);
    expect(groups.map(group => [group.key, group.threads.map(thread => thread.id)])).toEqual([
      ["today", [fixtureUuid(1), fixtureUuid(3)]], ["yesterday", [fixtureUuid(5)]], ["month", [fixtureUuid(6)]], ["2026-09", [fixtureUuid(4)]], ["2026-07", [fixtureUuid(2)]], ["2025-11", [fixtureUuid(7)]],
    ]);
  });

  it("labels groups in English and Russian, adding the year only for earlier years", () => {
    const label = (language: "en" | "ru", timestamp: number) => groupLabel(recencyGroup(timestamp, now), chatStrings(language), chatFormat(language), now);
    expect(label("en", at(9, 23))).toBe("Today");
    expect(label("ru", at(9, 22))).toBe("Вчера");
    expect(label("ru", at(9, 18))).toBe("Предыдущие 7 дней");
    expect(label("en", at(9, 1))).toBe("Last 30 days");
    expect(label("en", at(7, 3))).toBe("August");
    expect(label("ru", at(7, 3))).toBe("Август");
    expect(label("en", at(10, 3, 12, 2025))).toBe("November 2025");
    expect(label("ru", at(10, 3, 12, 2025))).toBe("Ноябрь 2025");
  });
});
