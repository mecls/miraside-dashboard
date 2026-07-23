import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { fetchLeadViews } from "@/lib/leads-data";

export const runtime = "nodejs";

/** List all stored leads (with ad + qualification) for the CRM view. Auth-gated; read-only. */
export async function GET() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  try {
    const leads = await fetchLeadViews(createAdminClient(), tenantId);
    return NextResponse.json({ ok: true, leads });
  } catch (e: any) {
    console.error("GET /api/leads failed:", e?.message ?? e);
    return NextResponse.json({ ok: false, error: "Failed to load leads." }, { status: 500 });
  }
}
