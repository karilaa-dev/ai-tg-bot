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
