import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { mirrorCallState } from "@/lib/cold-calls-writeback";
import { CALL_STATUSES } from "@/lib/cold-calls";

export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS_SET = new Set<string>(CALL_STATUSES as readonly string[]);
const CHANNELS = new Set(["call", "email", "linkedin", "whatsapp"]);
const MAX_TEXT = 5000;
const clip = (v: unknown) => String(v ?? "").trim().slice(0, MAX_TEXT) || null;

/**
 * Log a call attempt: append to cold_call_activities (full history) and roll the outcome up onto the
 * contact (call_status, attempts, last_attempt_at, next follow-up), then mirror the new status back to the
 * sheet. The chosen outcome IS the new call status (the vocabularies are the same).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing contact id." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const disposition = String(body.disposition ?? "").trim();
  if (!STATUS_SET.has(disposition) || disposition === "Not called") {
    return NextResponse.json({ ok: false, error: "Pick a valid call outcome." }, { status: 400 });
  }
  const channel = CHANNELS.has(String(body.channel)) ? String(body.channel) : "call";
  const reachedDM = typeof body.reachedDecisionMaker === "boolean" ? body.reachedDecisionMaker : null;

  let followUpIso: string | null = null;
  if (body.followUpAt) {
    const d = new Date(String(body.followUpAt));
    if (isNaN(d.getTime()) || d.getTime() > Date.now() + 400 * 86_400_000) {
      return NextResponse.json({ ok: false, error: "Invalid follow-up date." }, { status: 400 });
    }
    followUpIso = d.toISOString();
  }

  const admin = createAdminClient();
  const { data: c, error: readErr } = await admin
    .from("cold_call_contacts")
    .select("id, email, phone, person_linkedin, sheet_row, attempts, assigned_user, notes")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("POST /api/cold-calls/log read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load contact." }, { status: 500 });
  }
  if (!c) return NextResponse.json({ ok: false, error: "Contact not found." }, { status: 404 });

  const now = new Date().toISOString();
  const rep = String(body.rep ?? "").trim() || String(c.assigned_user ?? "") || null;

  const { data: activity, error: actErr } = await admin
    .from("cold_call_activities")
    .insert({
      tenant_id: tenantId,
      contact_id: id,
      rep,
      called_at: now,
      channel,
      disposition,
      reached_decision_maker: reachedDM,
      objection: clip(body.objection),
      next_step: clip(body.nextStep),
      follow_up_at: followUpIso,
      notes: clip(body.notes),
      created_by: user.id,
    })
    .select("id")
    .maybeSingle();
  if (actErr) {
    console.error("POST /api/cold-calls/log insert failed:", actErr.message);
    return NextResponse.json({ ok: false, error: "Failed to log the call." }, { status: 500 });
  }

  // Roll the outcome onto the contact.
  const contactPatch: Record<string, unknown> = {
    call_status: disposition,
    last_outcome: disposition,
    last_attempt_at: now,
    attempts: (Number(c.attempts) || 0) + (channel === "call" ? 1 : 0),
  };
  if (reachedDM !== null) contactPatch.reached_decision_maker = reachedDM;
  if (followUpIso) contactPatch.next_follow_up_at = followUpIso;
  const { error: upErr } = await admin.from("cold_call_contacts").update(contactPatch).eq("tenant_id", tenantId).eq("id", id);
  if (upErr) {
    console.error("POST /api/cold-calls/log contact update failed:", upErr.message);
    return NextResponse.json({ ok: false, error: "Call logged, but updating the contact failed." }, { status: 500 });
  }

  const writeback = await mirrorCallState(admin, tenantId, id, {
    email: String(c.email ?? ""),
    phone: String(c.phone ?? ""),
    personLinkedin: String(c.person_linkedin ?? ""),
    sheetRow: (c.sheet_row as number) ?? null,
    callStatus: disposition,
    assignedUser: String(c.assigned_user ?? ""),
    notes: String(c.notes ?? ""),
  });

  return NextResponse.json({ ok: true, activityId: activity?.id ?? null, callStatus: disposition, writeback });
}
