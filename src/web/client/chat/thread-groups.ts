import type { ChatThread } from "../../chat-types.js";
import type { ChatStrings, chatFormat } from "./strings.js";

export type RecencyGroup =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "week" }
  | { kind: "month" }
  | { kind: "calendar"; year: number; month: number };

export interface ThreadGroup<T> { key: string; group: RecencyGroup; threads: T[] }

const dayStart = (now: Date, daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();

/** Local calendar days, so the groups stay right across daylight-saving changes. */
export function recencyGroup(timestamp: number, now: number): RecencyGroup {
  const today = new Date(now);
  if (timestamp >= dayStart(today, 0)) return { kind: "today" };
  if (timestamp >= dayStart(today, 1)) return { kind: "yesterday" };
  if (timestamp >= dayStart(today, 7)) return { kind: "week" };
  if (timestamp >= dayStart(today, 30)) return { kind: "month" };
  const date = new Date(timestamp);
  return { kind: "calendar", year: date.getFullYear(), month: date.getMonth() };
}

const groupKey = (group: RecencyGroup) => group.kind === "calendar" ? `${group.year}-${String(group.month + 1).padStart(2, "0")}` : group.kind;
const groupRank = (group: RecencyGroup): [kind: number, age: number] => {
  switch (group.kind) {
    case "today": return [0, 0];
    case "yesterday": return [1, 0];
    case "week": return [2, 0];
    case "month": return [3, 0];
    case "calendar": return [4, -(group.year * 12 + group.month)];
    default: {
      const _exhaustive: never = group;
      return _exhaustive;
    }
  }
};

/** Newest groups first; threads keep their incoming order inside a group. */
export function groupThreads<T extends Pick<ChatThread, "lastActivity">>(threads: T[], now: number): ThreadGroup<T>[] {
  const groups = new Map<string, ThreadGroup<T>>();
  for (const thread of threads) {
    const group = recencyGroup(thread.lastActivity, now);
    const key = groupKey(group);
    const existing = groups.get(key);
    if (existing) existing.threads.push(thread);
    else groups.set(key, { key, group, threads: [thread] });
  }
  return [...groups.values()].sort((a, b) => {
    const [kindA, ageA] = groupRank(a.group);
    const [kindB, ageB] = groupRank(b.group);
    return kindA - kindB || ageA - ageB;
  });
}

export function groupLabel(group: RecencyGroup, t: ChatStrings, format: ReturnType<typeof chatFormat>, now: number): string {
  switch (group.kind) {
    case "today": return t.groupToday;
    case "yesterday": return t.groupYesterday;
    case "week": return t.groupWeek;
    case "month": return t.groupMonth;
    case "calendar": return format.month(group.year, group.month, new Date(now).getFullYear());
    default: {
      const _exhaustive: never = group;
      return _exhaustive;
    }
  }
}
