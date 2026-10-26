import { useEffect, useState } from "react";
import { localeFor, type UiLanguage } from "../i18n.js";

/** This browser's IANA zone, such as America/Los_Angeles. */
export function deviceZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/** Every zone this browser knows, plus UTC and the device's own zone when the list leaves them out. */
export function zoneNames(): string[] {
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const extra = ["UTC", deviceZone()].filter((zone): zone is string => Boolean(zone) && !listed.includes(zone!));
  return [...listed, ...extra].sort((a, b) => a.localeCompare(b));
}

/** Minutes east of UTC for a zone at a moment, or null when the browser does not know the zone. */
export function zoneOffset(timeZone: string, at = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
    const local = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    return Math.round((local - Math.floor(at.getTime() / 1_000) * 1_000) / 60_000);
  } catch { return null; }
}

export const utc = (minutes: number) => {
  const sign = minutes < 0 ? "−" : "+";
  const value = Math.abs(minutes);
  return `UTC${sign}${Math.floor(value / 60)}${value % 60 ? `:${String(value % 60).padStart(2, "0")}` : ""}`;
};

/** The wall-clock time in a zone, such as 2:54 PM. */
export function zoneTime(timeZone: string, language: UiLanguage, at = new Date()): string {
  try { return at.toLocaleTimeString(localeFor(language), { timeZone, hour: "numeric", minute: "2-digit" }); }
  catch { return at.toLocaleTimeString(localeFor(language), { hour: "numeric", minute: "2-digit" }); }
}

/** Search text for a zone, so "los angeles" or "america los" finds America/Los_Angeles. */
export const zoneSearchText = (timeZone: string) => timeZone.toLowerCase().replace(/[_/]+/g, " ");

/** The current time, refreshed on each minute boundary. */
export function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const untilNext = (date: Date) => 60_000 - (date.getSeconds() * 1_000 + date.getMilliseconds());
    let timer = setTimeout(function tick() {
      const next = new Date();
      setNow(next);
      timer = setTimeout(tick, untilNext(next));
    }, untilNext(new Date()));
    return () => clearTimeout(timer);
  }, []);
  return now;
}
