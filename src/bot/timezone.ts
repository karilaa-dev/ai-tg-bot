export function parseLocalTime(input: string): { minutes: number } | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3]?.toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "am" && hour === 12) hour = 0;
    else if (suffix === "pm" && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { minutes: hour * 60 + minute };
}

export function offsetFromLocalTime(input: string, now = new Date()): number | null {
  const parsed = parseLocalTime(input);
  if (!parsed) return null;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offset = parsed.minutes - utcMinutes;
  if (offset <= -720) offset += 1440;
  if (offset > 840) offset -= 1440;
  return Math.round(offset / 15) * 15;
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

/** The canonical spelling of an IANA time zone such as `europe/berlin`, or null when the name is unknown. */
export function canonicalTimeZone(input: string): string | null {
  const name = input.trim();
  if (!name || name.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(name)) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    // Engines differ on alias canonicalization; prefer the listed spelling when the input matches one case-insensitively.
    const listed = typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone").find(zone => zone.toLowerCase() === name.toLowerCase()) : undefined;
    return listed ?? resolved;
  } catch {
    return null;
  }
}

/** Minutes east of UTC for a time zone at a moment, so daylight saving is followed. */
export function zoneOffsetMinutes(timeZone: string, at = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  const local = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return Math.round((local - Math.floor(at.getTime() / 1_000) * 1_000) / 60_000);
}

/** A user's current UTC offset: from their named zone when set, else the saved offset, else null. */
export function userOffsetMinutes(user: { tz_name: string | null; tz_offset_min: number | null }, at = new Date()): number | null {
  if (user.tz_name) {
    try { return zoneOffsetMinutes(user.tz_name, at); } catch { /* An engine without this zone falls back to the saved offset. */ }
  }
  return user.tz_offset_min;
}

/** How a user's zone reads to them and to the model, such as `Europe/Berlin (UTC+01:00)`. */
export function describeUserTimeZone(user: { tz_name: string | null; tz_offset_min: number | null }, at = new Date()): string {
  const offset = formatUtcOffset(userOffsetMinutes(user, at) ?? 0);
  return user.tz_name ? `${user.tz_name} (${offset})` : offset;
}
