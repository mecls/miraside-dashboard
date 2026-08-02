/**
 * Shared constants + helpers for the batched (Development-tier-safe) launch flow. A batchable launch creates
 * its campaign + ad set + a first small batch, then drains the rest across paced background batches — each
 * batch small enough to stay under Meta's Development-tier score cap, spaced so the score recovers between them.
 */
export const BATCH_SIZE = 5; // ads per batch — under the Dev-tier score cap (writes cost 3 pts, cap ~60)
export const BATCH_INTERVAL_MS = 180_000; // wait between batches so the rate-limit score recovers (~3 min)
export const MAX_STALLS = 8; // give up after this many consecutive no-progress batches (~24 min of retries)

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turn a raw Meta/launch error into a short, user-facing reason shown on the history entry. */
export function friendlyError(raw: string): string {
  if (/request limit|too many (calls|api)|reduce the amount|account has too many|rate limit/i.test(raw)) {
    return "Meta rate limit — your ad account's API tier (Development Access) can't create this many ads at once. Launch fewer (~5) at a time, or upgrade the app to Standard Access.";
  }
  return (raw || "No ads were created.").slice(0, 600); // room for Meta's error_user_msg + blame_field_specs
}

/** Kick the self-chaining batch processor (best-effort, a few retries). Hits the stable public alias so it's
 *  never blocked by Vercel deployment protection; the job lives in the DB, so any deployment can process it. */
export async function triggerProcess(): Promise<void> {
  const base = process.env.LAUNCH_BASE_URL || "https://dashboard.miraside.co";
  const secret = process.env.SYNC_TRIGGER_SECRET || "";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${base}/api/launches/process`, { method: "POST", headers: { "x-launch-secret": secret } });
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
}
