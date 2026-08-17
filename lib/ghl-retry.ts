/**
 * Retry helper for transient GoHighLevel upstream blips. GHL's load balancer occasionally returns
 * 502/503/504 ("no healthy upstream") or the request dies at the network layer (DNS/reset) — both are
 * transient and safe to retry. Mirrors lib/meta.ts's withRetry: only transient errors retry, everything
 * else (4xx validation, 500 app errors) propagates immediately so we don't hammer real failures. With
 * this in the fetch layer, the scheduled Leads sync only surfaces an Automation Error after retries are
 * exhausted — a single GHL hiccup no longer pages anyone.
 *
 * Safe for our POST callers: contacts/upsert dedupes by phone/email (idempotent), and a 5xx/network
 * failure means the request almost certainly never reached GHL's app, so a retry can't double-write.
 */

// Transient upstream/gateway statuses (parsed from our thrown "GHL <path> <status>: …" messages).
// 520-524 are Cloudflare's OWN edge errors (GHL sits behind Cloudflare), not GHL app responses: 522
// "Connection timed out" paged the Automation Errors channel on 2026-08-16 for a blip that self-healed
// on the next cycle. They belong with the other gateway statuses. Note the body text ("Connection timed
// out") matches none of the regex fallbacks below, so without the numeric entry a 522 fails hard.
//
// Safe to retry: the only NON-idempotent GHL calls we make (task create, note create) never reach
// withGhlRetry at all — ghlFetch passes retry=false for them precisely so a landed-but-timed-out request
// can't double-create. Everything that DOES retry is an upsert (GHL dedupes on phone/email), a scoped
// tag add/remove, a PUT, or a DELETE that treats "already gone" as success.
const TRANSIENT_STATUS = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GHL's contact search intermittently 400s with its own internal failure ("Error occurred while searching
 * for contact" + a traceId) — their bug, not our request: the identical call succeeds on retry. It's the
 * one 400 that's transient, so match it narrowly (message text, not the status) and let every other 400
 * keep failing fast. Without this a single blip killed a whole scheduled Leads sync.
 */
const TRANSIENT_400 = /error occurred while searching for contact/i;

/**
 * GHL also mislabels its own internal timeouts as 401 ({"statusCode":401,"message":"Command timed out"},
 * seen on contacts/search 2026-07-18). A REAL 401 (bad token) must keep failing fast, so match the
 * timeout body text — not the status.
 */
const TRANSIENT_TIMEOUT_BODY = /command timed out/i;

/** True for transient GHL failures: a 429/502/503/504, GHL's flaky contact-search 400, an internal
 *  timeout mislabeled as 401, or a network blip. */
export function isTransientGhlError(e: unknown): boolean {
  // A bounded fetch timeout (ghlFetch's AbortSignal.timeout) throws a DOMException named "TimeoutError"
  // (a manual abort → "AbortError"). Treat a slow-GHL hang as transient so an idempotent write retries
  // rather than failing fast on one degraded response. Read `.name` directly — a DOMException isn't always
  // an Error instance in Node.
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const m = e instanceof Error ? e.message : String(e);
  const status = m.match(/\s(\d{3}):\s/)?.[1];
  if (status && TRANSIENT_STATUS.has(Number(status))) return true;
  if (TRANSIENT_400.test(m)) return true;
  if (TRANSIENT_TIMEOUT_BODY.test(m)) return true;
  return /no healthy upstream|temporarily unavailable|bad gateway|gateway time-?out|service unavailable|too many requests|aborted due to timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network (error|timeout)/i.test(
    m
  );
}

/** Run a GHL request, auto-retrying transient blips with exponential backoff. Other errors propagate. */
export async function withGhlRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientGhlError(e) || i === tries - 1) throw e;
      await sleep(800 * 2 ** i); // 0.8s → 1.6s → 3.2s
    }
  }
  throw last;
}
