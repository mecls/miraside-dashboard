import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { syncColdCallsFromSheet } from "@/lib/cold-calls-sync";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Pull the "Portugal Leads" sheet into cold_call_contacts. Triggered by the "Sync now" button (signed-in
 *  user) or the scheduled cron (CRON_SECRET). */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const cronOk =
    !!secret &&
    (req.headers.get("authorization") === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret);

  if (!cronOk) {
    const sb = await createServerSupabase();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  try {
    const summary = await syncColdCallsFromSheet(createAdminClient(), tenantId);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("cold-calls sync failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
