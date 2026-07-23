import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { ghlConfig, fetchOpportunitiesByContact, updateOpportunityValue } from "@/lib/ghl-write";

export const runtime = "nodejs";
export const maxDuration = 30; // bound a hung GHL call so it can't hold the function to the platform limit

/**
 * Deal value on a lead's GHL opportunity. The opportunity itself is created by a GHL WORKFLOW when a
 * call gets booked — this route never creates one. It links on demand (searches by contact when the
 * 30-min sync hasn't discovered it yet, so the operator can type the value seconds after booking),
 * writes the value to GHL FIRST (source of truth), then mirrors it locally.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant configured." }, { status: 400 });
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing lead id." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const raw = Number(body.valueEur);
  if (!Number.isFinite(raw) || raw < 0 || raw > 10_000_000) {
    return NextResponse.json({ error: "Enter a value in euros (0 or more)." }, { status: 400 });
  }
  const valueEur = Math.round(raw * 100) / 100;

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, ghl_contact_id, ghl_opportunity_id, opportunity_status, opportunity_won_at, deleted_at")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (!lead || lead.deleted_at) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  if (!ghlConfig() || !lead.ghl_contact_id) {
    return NextResponse.json({ error: "This lead isn't linked to GoHighLevel." }, { status: 400 });
  }

  try {
    // Resolve the opportunity: the stored link, else discover it right now (the GHL workflow may have
    // created it seconds ago — don't make the operator wait for the next sync).
    let oppId = (lead.ghl_opportunity_id as string | null) ?? null;
    if (!oppId) {
      const opps = await fetchOpportunitiesByContact(lead.ghl_contact_id as string);
      const opp =
        opps.find((o) => o.status === "open") ??
        [...opps].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0] ??
        null;
      oppId = opp?.id ?? null;
    }
    if (!oppId) {
      // 409, not 500: nothing is broken — the booking workflow just hasn't created the deal yet.
      return NextResponse.json(
        { error: "No GoHighLevel opportunity for this contact yet. It's created when a meeting gets booked." },
        { status: 409 }
      );
    }

    const updated = await updateOpportunityValue(oppId, valueEur);
    // status null = GHL's response carried none → keep what we had; never fabricate "open" (that once
    // flipped a stored won deal back and vanished its close until the next sync).
    const status = updated.status ?? (lead.opportunity_status as string | null) ?? null;
    await admin
      .from("leads")
      .update({
        ghl_opportunity_id: updated.id,
        opportunity_value: updated.monetaryValue ?? valueEur,
        opportunity_status: status,
        // A value edit that reveals a won deal also dates the close (else it sits dateless until sync).
        ...(status === "won" && !lead.opportunity_won_at ? { opportunity_won_at: new Date().toISOString() } : {}),
      })
      .eq("id", id);
    return NextResponse.json({ opportunityId: updated.id, value: updated.monetaryValue ?? valueEur, status });
  } catch (e) {
    console.error("opportunity PATCH failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't save the value to GoHighLevel." }, { status: 502 });
  }
}
