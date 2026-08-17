import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runScheduledSync } from "@/lib/sync/scheduled";
import { isTransientError } from "@/lib/meta";
import { isTransientGhlError } from "@/lib/ghl-retry";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
/**
 * Rolling-window FB sync + the leads pull.
 *
 * Why 300 and not 120: the leads pass makes ~2.5 SERIAL GoHighLevel calls per linked lead (a task read
 * and a notes read are ungated, plus appointment/opportunity reads for leads with meetings) — at 141
 * linked leads that is ~360 round-trips. GHL caps us at 100 requests / 10s per location, so there is a
 * hard ~36s floor that grows linearly with the lead count. 120 sat right on top of that: a slow cycle was
 * killed by the platform mid-write, which ALSO meant the transient-suppression below never got to run and
 * n8n reported a bare "timeout of 120000ms exceeded" instead. 300 is the platform default and is already
 * proven on this account (app/api/launches/{create,process}).
 *
 * This is headroom, not the fix — the durable fix is making FEWER GHL calls (staggered notes/task
 * refresh + a shared token-bucket limiter), since at a fixed 10 req/s the cost is call COUNT, not
 * concurrency. Until that lands, keep the n8n client timeout ABOVE this number or the client gives up
 * before the route can answer.
 */
export const maxDuration = 300;

/**
 * Scheduled Facebook sync endpoint. Two callers, two verbs — same work (runScheduledSync):
 *   - GET  = Vercel Cron (every 30 min; see vercel.json). Vercel adds `Authorization: Bearer $CRON_SECRET`.
 *            This is the RELIABLE native scheduler — it doesn't depend on any external service being up.
 *   - POST = the n8n Schedule Trigger (a redundant second scheduler), with a JSON body for custom windows.
 *
 * Auth is secret-based and never coupled to NODE_ENV, so a mis-set env can't silently open a
 * service-role-powered sync endpoint:
 *   - GET  requires `Authorization: Bearer <CRON_SECRET | SYNC_TRIGGER_SECRET>`.
 *   - POST requires a matching `x-sync-token` (SYNC_TRIGGER_SECRET); secret-less access only via the
 *     explicit ALLOW_INSECURE_SYNC=1 dev flag.
 *
 * Body (POST, optional JSON): { "backfillDays": number, "windowDays": number }
 *   - omitted -> rolling defaults (14d daily / 30d window): fast, idempotent, self-healing.
 */
const DEFAULT_ROLLING_BACKFILL_DAYS = 14;

function eq(a: string, b: string): boolean {
  try {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/** POST (n8n): match the `x-sync-token` header against SYNC_TRIGGER_SECRET. */
function postAuthorized(req: Request): boolean {
  const expected = process.env.SYNC_TRIGGER_SECRET;
  // Fail CLOSED in production: an absent secret must never open this service-role endpoint, even if the
  // ALLOW_INSECURE_SYNC dev flag lingers in a prod env. The escape hatch is dev/preview only.
  if (!expected) return process.env.ALLOW_INSECURE_SYNC === "1" && process.env.VERCEL_ENV !== "production";
  return eq(req.headers.get("x-sync-token") ?? "", expected);
}

/** GET (Vercel Cron): match the Bearer token against CRON_SECRET, or SYNC_TRIGGER_SECRET as a fallback. */
function getAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cron = process.env.CRON_SECRET;
  const sync = process.env.SYNC_TRIGGER_SECRET;
  if (cron && eq(auth, `Bearer ${cron}`)) return true;
  if (sync && eq(auth, `Bearer ${sync}`)) return true;
  return false;
}

/** Minutes since the last COMPLETED sync (leads is the run's final phase, so its stamp ≈ full-sync
 *  success). Infinity when unknown — unknown must never suppress an alert. */
async function minutesSinceLastSync(): Promise<number> {
  try {
    const { data } = await createAdminClient()
      .from("leads")
      .select("synced_at")
      .order("synced_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return data?.synced_at ? (Date.now() - new Date(data.synced_at).getTime()) / 60_000 : Infinity;
  } catch {
    return Infinity;
  }
}

/** Freshness threshold for suppressing transient-failure alerts: 3 missed half-hour cycles. Past this,
 *  the dashboard is genuinely stale and the schedulers SHOULD page — blip or not. */
const STALE_ALERT_MINUTES = 90;

async function runAndRespond(backfillDays: number, windowDays?: number) {
  try {
    // Scheduler path: keep the launch self-heal. A `skipped` result (an active launch was draining, so the
    // Meta pull was intentionally deferred) is still a SUCCESS — never a failure a scheduler should alert on.
    const { summary, leads, skipped } = await runScheduledSync({ backfillDays, windowDays, selfHeal: true });
    return NextResponse.json({ ok: true, ...(summary ?? {}), leads, ...(skipped ? { skipped } : {}) });
  } catch (e: any) {
    const raw = e?.message ?? "Sync failed";
    console.error("sync/facebook failed:", raw);
    // Pass through Meta API messages (rate-limit codes 613/80004 let a caller back off + retry);
    // mask everything else (e.g. Postgres detail) so internals never leak in the response.
    const safe = /^Meta API /.test(raw) ? raw : "Sync failed";
    // Transient upstream blips (Meta code 1/2, GHL gateway hiccups) self-heal: two redundant schedulers
    // re-run every 15 min and the in-process retries already backed off. While the data is still FRESH,
    // a non-2xx here only produces Slack noise (3 pings during Meta's 2026-07-19 morning outage) — answer
    // 200 so the scheduler stays quiet, and keep failing loudly the moment staleness is real.
    if (isTransientError(e) || isTransientGhlError(e)) {
      const age = await minutesSinceLastSync();
      if (age < STALE_ALERT_MINUTES) {
        console.warn(`sync/facebook transient failure suppressed (last sync ${Math.round(age)}m ago):`, raw);
        return NextResponse.json({ ok: false, transient: true, error: safe, lastSyncMinutesAgo: Math.round(age) });
      }
    }
    return NextResponse.json({ ok: false, error: safe }, { status: 502 });
  }
}

export async function GET(req: Request) {
  if (!getAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return runAndRespond(DEFAULT_ROLLING_BACKFILL_DAYS);
}

export async function POST(req: Request) {
  if (!postAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Body is optional; tolerate empty/invalid JSON by falling back to defaults.
  let body: { backfillDays?: unknown; windowDays?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const backfillDays =
    typeof body.backfillDays === "number" && body.backfillDays > 0
      ? Math.min(Math.floor(body.backfillDays), 365)
      : DEFAULT_ROLLING_BACKFILL_DAYS;
  const windowDays =
    typeof body.windowDays === "number" && body.windowDays > 0
      ? Math.min(Math.floor(body.windowDays), 365)
      : undefined;

  return runAndRespond(backfillDays, windowDays);
}
