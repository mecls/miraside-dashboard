import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { runLeadsSync } from "@/lib/sync/leads";
import { activeLaunchInFlight } from "@/lib/sync/scheduled";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Manual "Refresh leads" — pulls from Meta + GHL on demand. Any signed-in user may trigger it.
 *
 * LAUNCH GUARD: runLeadsSync reads every lead form on the Page, which competes for the same Dev-tier
 * Meta rate budget a batched launch is draining. That contention trips Meta code 17 and silently
 * under-delivers the launch (it cost 3 of 28 ads on 2026-07-01). Every other sync trigger already
 * refuses to read Meta mid-launch via runScheduledSync; this route called runLeadsSync directly and
 * inherited none of that protection, so one click here could break a live launch.
 */
export async function POST() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const admin = createAdminClient();
  if (await activeLaunchInFlight(admin)) {
    // Same posture and wording as the sidebar Refresh, so the two buttons behave alike.
    return NextResponse.json({
      ok: true,
      skipped: "active-launch",
      note: "A launch is in progress — refresh paused so it doesn't disrupt delivery. Try again shortly.",
    });
  }

  try {
    const summary = await runLeadsSync(admin, tenantId);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e: any) {
    const raw = e?.message ?? "Refresh failed";
    console.error("leads refresh failed:", raw);
    const safe = /^Meta API |^GHL |^leads upsert/.test(raw) ? raw : "Refresh failed";
    return NextResponse.json({ ok: false, error: safe }, { status: 502 });
  }
}
