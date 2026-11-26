/** When a rate-limited turn may be retried. */
export type RateLimitRetry =
  | { kind: "at"; at: Date }
  /** The provider gave no time; the caller backs off. */
  | { kind: "backoff" };

const RATE_LIMIT_PATTERN =
  /\b429\b|RESOURCE_EXHAUSTED|resource exhausted|rate[ -]?limit(?:ed)?|too many requests|cooling down/i;

// "not asked again before 17:58 UTC+8", "retry after 09:30", "try again at 17:58:30 (UTC-05:00)".
const CLOCK_TIME_PATTERN =
  /(?:not asked again before|retry after|try again (?:at|after)|available (?:at|after)|resets? at)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*\(?\s*(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?\s*\)?)?/i;

/** A clock time this far in the past is taken to mean the same time tomorrow. */
const PAST_TOLERANCE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads a turn failure as a rate limit. Returns null for any other error. A clock time without
 * a UTC offset is read in the daemon's own time zone.
 */
export function parseRateLimitRetry(message: string, now: Date): RateLimitRetry | null {
  if (!RATE_LIMIT_PATTERN.test(message)) return null;
  const match = CLOCK_TIME_PATTERN.exec(message);
  if (!match) return { kind: "backoff" };
  const [, hours, minutes, seconds, sign, offsetHours, offsetMinutes] = match;
  const h = Number(hours);
  const m = Number(minutes);
  const s = seconds ? Number(seconds) : 0;
  if (h > 23 || m > 59 || s > 59) return { kind: "backoff" };

  let at: number;
  if (sign) {
    const offsetMs =
      (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes ?? 0)) * 60_000;
    // The same wall-clock day in the stated zone, then back to UTC.
    const zoned = new Date(now.getTime() + offsetMs);
    at =
      Date.UTC(zoned.getUTCFullYear(), zoned.getUTCMonth(), zoned.getUTCDate(), h, m, s) - offsetMs;
  } else {
    at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
  }
  if (at < now.getTime() - PAST_TOLERANCE_MS) at += DAY_MS;
  return { kind: "at", at: new Date(at) };
}
