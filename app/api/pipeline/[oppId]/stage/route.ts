import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { ghlConfig, moveOpportunityToStage, updateOpportunityStatus } from "@/lib/ghl-write";

export const runtime = "nodejs";
export const maxDuration = 30; // bound a hung GHL call so it can't hold the function to the platform limit

/**
 * Move a GHL opportunity between pipeline stages (the Pipeline board's drag / stage dropdown). GHL is the
 * source of truth — we write there FIRST, then converge the local mirror.
 *
 * Stage and status are separate in GHL. To keep the dashboard's revenue in step with the board, dragging
 * a deal INTO a stage named "Won" also flips its status to won (and dates the close on the linked lead);
 * dragging a currently-won deal OUT of Won reopens it. This mirrors the meetings route's won / un-won path
 * so the two entry points to "Won" can never diverge.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ oppId: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant configured." }, { status: 400 });
  if (!ghlConfig()) return NextResponse.json({ error: "GoHighLevel isn't configured." }, { status: 400 });

  const { oppId } = await params;
  if (!oppId) return NextResponse.json({ error: "Missing opportunity id." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const pipelineId = typeof body.pipelineId === "string" ? body.pipelineId : "";
  const stageId = typeof body.stageId === "string" ? body.stageId : "";
  const stageName = typeof body.stageName === "string" ? body.stageName : "";
  if (!pipelineId || !stageId) {
    return NextResponse.json({ error: "Missing pipeline or stage." }, { status: 400 });
  }
  const toWon = stageName.trim().toLowerCase() === "won";

  const admin = createAdminClient();

  try {
    // 1) The move itself (throws on GHL rejection → caught below, card reverts).
    await moveOpportunityToStage(oppId, pipelineId, stageId);

    // 2) Keep won-status in step with the Won stage, both directions.
    const { data: linked } = await admin
      .from("leads")
      .select("id, opportunity_status")
      .eq("tenant_id", tenantId)
      .eq("ghl_opportunity_id", oppId)
      .is("deleted_at", null)
      .maybeSingle();
    let status: string | null = (linked?.opportunity_status as string | null) ?? null;

    if (toWon && status !== "won") {
      await updateOpportunityStatus(oppId, "won");
      status = "won";
      await admin
        .from("leads")
        .update({ opportunity_status: "won", opportunity_won_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("ghl_opportunity_id", oppId);
    } else if (!toWon && status === "won") {
      // Left the Won stage → reopen so a mis-drag can't strand a phantom close.
      await updateOpportunityStatus(oppId, "open");
      status = "open";
      await admin
        .from("leads")
        .update({ opportunity_status: "open", opportunity_won_at: null })
        .eq("tenant_id", tenantId)
        .eq("ghl_opportunity_id", oppId);
    }

    return NextResponse.json({ ok: true, oppId, stageId, status });
  } catch (e) {
    console.error("pipeline stage PATCH failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't move the deal in GoHighLevel." }, { status: 502 });
  }
}
