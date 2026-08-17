import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFacebookSync, type SyncSummary } from "@/lib/sync/facebook";
import { runLeadsSync } from "@/lib/sync/leads";
import { getPrimaryTenantId } from "@/lib/tenant";
import { reportError } from "@/lib/alert";
import { triggerProcess } from "@/lib/launch-batch";

/**
 * The full scheduled refresh, in one place. Shared by all three callers so they do the SAME work:
 *   - n8n Schedule Trigger      (POST /api/sync/facebook, :00/:30) — external scheduler        [selfHeal]
 *   - Supabase pg_cron          (POST /api/sync/facebook, :15/:45) — redundant, staggered      [selfHeal]
 *   - in-app Refresh button     (POST /api/sync/refresh)           — on-demand, user-triggered [read-only]
 *
 * NOTE: there is no Vercel Cron. This list previously claimed one ("the reliable native scheduler"), but
 * the repo has no vercel.json/vercel.ts, so the GET handler it referred to was never reachable and was
 * deleted 2026-08-17. Both live schedulers are EXTERNAL — that is the actual reliability posture.
 *
 * Two safety rules baked in here so every caller inherits them:
 *
 *  1. Batched-launch hazard — while a launch is draining, a heavy Meta pull would contend for the shared
 *     Dev-tier rate budget and can trip Meta code 17, under-delivering the launch (it cost us 3/28 ads on
 *     2026-07-01). So we SKIP the Meta read whenever a launch is in flight and report `skipped`.
 *
 *  2. Launch self-heal (poke the processor so a broken self-chain drains + time out zombie LAUNCHING rows)
 *     is a SCHEDULER-only side effect. The user-facing Refresh button must be a pure data pull, so it
 *     passes `selfHeal:false` and never mutates launch state.
 */
export interface ScheduledSyncResult {
  summary: SyncSummary | null; // null when the Meta pull was skipped (active launch)
  leads: unknown;
  skipped?: "active-launch";
}

/**
 * A batched launch is in flight when an ad_launches row is LAUNCHING and was launched recently (the drain
 * self-chains within ~20 min). Bounded so an ancient stuck row can't wedge the sync off forever — a true
 * zombie (older than the window) is left for the self-heal below to time out to PARTIAL.
 */
export async function activeLaunchInFlight(admin: SupabaseClient): Promise<boolean> {
  const cutoff = new Date(Date.now() - 25 * 60_000).toISOString();
  const { data } = await admin
    .from("ad_launches")
    .select("id")
    .eq("status", "LAUNCHING")
    .gte("launched_at", cutoff)
    .limit(1);
  return !!(data && data.length);
}

export async function runScheduledSync(opts: {
  backfillDays: number;
  windowDays?: number;
  selfHeal?: boolean;
}): Promise<ScheduledSyncResult> {
  const selfHeal = opts.selfHeal ?? true;
  const admin = createAdminClient();
  const launchActive = await activeLaunchInFlight(admin);

  let summary: SyncSummary | null = null;
  let leads: unknown = null;

  // Rule 1: never read Meta while a launch drains (code 17 → lost ads). Common case: no launch → full pull.
  if (!launchActive) {
    summary = await runFacebookSync(admin, { backfillDays: opts.backfillDays, windowDays: opts.windowDays });

    // Leads sync rides the same trigger; its failure must never fail the FB sync.
    try {
      const tenantId = await getPrimaryTenantId();
      if (tenantId) leads = await runLeadsSync(createAdminClient(), tenantId);
    } catch (e: any) {
      console.error("leads sync (within scheduled sync) failed:", e?.message ?? e);
      leads = { error: "leads sync failed" };
      await reportError("Leads sync (scheduled)", e);
    }
  }

  // Rule 2: launch self-heal is scheduler-only (never the user Refresh). Safe even during an active launch:
  // triggerProcess is the drain's own continuation, and the PARTIAL flip only matches stale zombie rows
  // (pending cleared + launched_at past the cutoff), never a healthy in-flight launch.
  if (selfHeal) {
    try {
      await triggerProcess();
      const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
      await admin
        .from("ad_launches")
        .update({ status: "PARTIAL", last_error: "Launch interrupted — the server stopped mid-launch. Some ads may not have been created." })
        .eq("status", "LAUNCHING")
        .is("pending", null)
        .lt("launched_at", cutoff);
    } catch (e: any) {
      console.error("launch self-heal failed:", e?.message ?? e);
    }
  }

  return { summary, leads, ...(launchActive ? { skipped: "active-launch" as const } : {}) };
}
