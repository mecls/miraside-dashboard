/**
 * Account-timezone calendar-date helpers.
 *
 * Meta returns insights bucketed in the ad account's timezone (`date_start`), so
 * every window boundary we compute — "today", N-days-ago, the sync watermark — must
 * use that SAME timezone, not the server's UTC. Mixing UTC boundaries with
 * account-tz data drifts the window by a day near midnight and makes spend disagree
 * with Ads Manager (plan §10; acceptance criteria 1 & 23).
 *
 * All values are `YYYY-MM-DD` calendar strings; no time-of-day is ever exposed.
 */

const FALLBACK_TZ = "UTC";

/** `YYYY-MM-DD` for the current instant, as seen in the given IANA timezone. */
export function todayInTz(timeZone?: string | null): string {
  // en-CA renders as ISO (YYYY-MM-DD); the timeZone option does the tz conversion.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || FALLBACK_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    // Invalid/unknown IANA name -> fall back to UTC rather than throw mid-sync.
    return new Date().toISOString().slice(0, 10);
  }
}

/** `YYYY-MM-DD` for a specific instant (ISO string, epoch ms, or Date), as seen in the given IANA timezone.
 *  Used to map a lead's `created_time` to the SAME account-tz calendar day Meta bucketed its insights under,
 *  so a per-ad lead exclusion lines up with the right `fb_insights_daily.date` row. */
export function dateInTz(instant: string | number | Date, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || FALLBACK_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instant));
  } catch {
    return new Date(instant).toISOString().slice(0, 10);
  }
}

/** Shift a `YYYY-MM-DD` string by `n` calendar days (negative = earlier). */
export function addDays(dateStr: string, n: number): string {
  // Anchor at noon UTC so a ±n-day shift never lands on a DST gap/overlap.
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for `n` days before today, in the given timezone. */
export function daysAgoInTz(timeZone: string | null | undefined, n: number): string {
  return addDays(todayInTz(timeZone), -n);
}
