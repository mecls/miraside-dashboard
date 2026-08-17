import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { runScheduledSync } from "@/lib/sync/scheduled";

export const runtime = "nodejs";
// Matches /api/sync/facebook (300) on purpose: this button runs the SAME runScheduledSync, so the leads
// pass costs the same ~64s and swings with GHL's latency (89.5s and 133s were both measured on identical
// code on 2026-08-17). At 120 a slow click was killed mid-write — the user's problem was never the wait,
// it was a half-finished sync. Normal runs still return in about a minute; this is only the ceiling.
export const maxDuration = 300;

/**
 * In-app manual refresh — the sidebar "Refresh data" button. Any signed-in user may fire it because it's a
 * pure DATA PULL: `selfHeal:false` means it does NOT poke the launch processor or touch ad_launches state
 * (those side effects belong only to the secret-authenticated cron/n8n schedulers). It just re-reads
 * campaigns/spend/leads from Meta, so no admin gate is needed.
 *
 * Short backfill for responsiveness: the full campaign→adset→ad hierarchy is ALWAYS pulled (that's what
 * makes a just-launched campaign appear), and insights refresh the last few days. The 30-min scheduled
 * job carries the deep 14-day insight window, so nothing is lost by keeping the click fast.
 *
 * If a batched launch is draining, runScheduledSync returns `skipped` (it won't read Meta mid-launch — the
 * code-17 hazard); we surface that to the button so the user sees why the refresh deferred.
 */
export async function POST() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { summary, leads, skipped } = await runScheduledSync({ backfillDays: 3, selfHeal: false });
    if (skipped === "active-launch") {
      return NextResponse.json({ ok: true, skipped, note: "A launch is in progress — refresh paused so it doesn't disrupt delivery. Try again shortly." });
    }
    return NextResponse.json({ ok: true, hierarchy: summary?.hierarchy, leads });
  } catch (e: any) {
    const raw = e?.message ?? "Sync failed";
    console.error("sync/refresh failed:", raw);
    // Surface Meta rate-limit/API messages to the toast; mask everything else.
    const safe = /^Meta API /.test(raw) ? raw : "Sync failed";
    return NextResponse.json({ ok: false, error: safe }, { status: 502 });
  }
}
