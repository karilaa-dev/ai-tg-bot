const THIRTY_MINUTES_MS = 30 * 60_000;
const RESET_GRACE_MS = 60_000;

export type CodexAttempt =
  | { allowed: true; probe: boolean }
  | { allowed: false; retryAt: number };

export class CodexCircuitBreaker {
  private open = false;
  private blockedUntil = 0;
  private nextProbeAt = 0;
  private probeActive = false;

  constructor(private readonly now: () => number = Date.now) {}

  acquire(): CodexAttempt {
    const now = this.now();
    if (!this.open) return { allowed: true, probe: false };
    if (now < this.nextProbeAt || this.probeActive) {
      return { allowed: false, retryAt: this.nextProbeAt };
    }
    this.probeActive = true;
    return { allowed: true, probe: true };
  }

  recordSuccess(): void {
    this.open = false;
    this.blockedUntil = 0;
    this.nextProbeAt = 0;
    this.probeActive = false;
  }

  recordFailure(resetAt?: number): void {
    const now = this.now();
    this.open = true;
    const knownReset = resetAt !== undefined && Number.isFinite(resetAt) && resetAt > now;
    const effectiveReset = knownReset ? resetAt : now + THIRTY_MINUTES_MS;
    this.blockedUntil = Math.max(this.blockedUntil, effectiveReset);
    this.nextProbeAt = knownReset && effectiveReset - now <= THIRTY_MINUTES_MS
      ? effectiveReset + RESET_GRACE_MS
      : Math.min(effectiveReset, now + THIRTY_MINUTES_MS);
    this.probeActive = false;
  }

  releaseProbe(): void {
    this.probeActive = false;
  }

  state(): { open: boolean; blockedUntil: number; nextProbeAt: number; probeActive: boolean } {
    return {
      open: this.open,
      blockedUntil: this.blockedUntil,
      nextProbeAt: this.nextProbeAt,
      probeActive: this.probeActive,
    };
  }
}

export function retryableCodexError(input: { status?: number; message?: string }): boolean {
  const status = input.status;
  const text = input.message?.toLowerCase() ?? "";
  if (/context|maximum.*tokens|content policy|safety|invalid request|tool.*(error|failed)/i.test(text)) return false;
  if (status === 401 || status === 403 || status === 408 || status === 429) return true;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (!text) return false;
  return /rate.?limit|quota|usage limit|refresh token|oauth|unauthori[sz]ed|forbidden|network|fetch failed|socket|timeout|timed out|econn|enotfound|service unavailable|gateway/i.test(text);
}

export function resetAtFromHeaders(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const retryAfter = header(headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date;
  }
  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const value = header(headers, name);
    if (!value) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (numeric > 10_000_000_000) return numeric;
      if (numeric > 1_000_000_000) return numeric * 1000;
      if (numeric >= 0) return now + numeric * 1000;
    }
    const duration = parseDuration(value);
    if (duration !== undefined) return now + duration;
  }
  return undefined;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function parseDuration(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}
