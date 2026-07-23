import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { ghlConfig, updateAppointmentStatus, fetchOpportunitiesByContact, updateOpportunityStatus, moveOpportunityToWonStage, createContactTask, completeContactTask } from "@/lib/ghl-write";
import { listOpenContactTasks, fetchContactOpenTask } from "@/lib/ghl";
import { ATTENDANCE_VALUES, OUTCOME_VALUES, DISQUALIFY_VALUES, outcomeAppliesTo, leadNeedsRebooking, REBOOK_TASK_TITLE, REBOOK_TASK_RE, type LeadMeeting } from "@/lib/meetings";

export const runtime = "nodejs";
export const maxDuration = 30; // bound a hung GHL call so it can't hold the function to the platform limit

const MAX_NOTES_LEN = 2000;

/**
 * A lead's call history — one row per booked meeting, and what came of each.
 *
 * Two layers, deliberately separate:
 *  • attendance (scheduled / showed / no_show / cancelled) is GoHighLevel's OWN vocabulary, so it is
 *    written back there — the CRM calendar stays honest for anyone not looking at this dashboard;
 *  • outcome (follow-up booked / proposal sent / won / disqualified) has no GHL equivalent and lives
 *    only here.
 *
 * Setting either stamps `outcome_set_at`, which is what stops the 30-minute mirror from overwriting a
 * human judgement with GoHighLevel's default "confirmed".
 */
function toView(r: Record<string, any>): LeadMeeting {
  return {
    id: String(r.id),
    ghlAppointmentId: r.ghl_appointment_id ?? null,
    calendarId: r.calendar_id ?? null,
    startsAt: r.starts_at,
    endsAt: r.ends_at ?? null,
    title: r.title ?? null,
    link: r.link ?? null,
    attendance: r.attendance,
    outcome: r.outcome ?? null,
    disqualifyReason: r.disqualify_reason ?? null,
    notes: r.notes ?? null,
    confirmedAt: r.confirmed_at ?? null,
  };
}

async function resolve(params: Promise<{ id: string }>) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return { error: NextResponse.json({ error: "No tenant configured." }, { status: 400 }) };
  const { id } = await params;
  if (!id) return { error: NextResponse.json({ error: "Missing lead id." }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, ghl_contact_id, ghl_opportunity_id, opportunity_won_at")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!lead) return { error: NextResponse.json({ error: "Lead not found." }, { status: 404 }) };
  return {
    admin,
    tenantId,
    id,
    contactId: (lead.ghl_contact_id as string | null) ?? null,
    opportunityId: (lead.ghl_opportunity_id as string | null) ?? null,
    wonAt: (lead.opportunity_won_at as string | null) ?? null,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(params);
  if ("error" in r) return r.error;
  const { data, error } = await r.admin
    .from("lead_meetings")
    .select("*")
    .eq("tenant_id", r.tenantId)
    .eq("lead_id", r.id)
    .order("starts_at", { ascending: false });
  if (error) {
    console.error("meetings GET failed:", error.message);
    return NextResponse.json({ error: "Couldn't load the call history." }, { status: 500 });
  }
  return NextResponse.json({ meetings: (data ?? []).map(toView) });
}

/** Record what happened on one call. Any subset of {attendance, outcome, disqualifyReason, notes,
 *  confirmed} — `confirmed` is the day-before confirmation tick (boolean → confirmed_at stamp). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(params);
  if ("error" in r) return r.error;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const meetingId = typeof body.meetingId === "string" ? body.meetingId.trim() : "";
  if (!meetingId) return NextResponse.json({ error: "Missing meeting." }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("attendance" in body) {
    const v = String(body.attendance ?? "");
    if (!ATTENDANCE_VALUES.has(v)) return NextResponse.json({ error: "Unknown attendance." }, { status: 400 });
    patch.attendance = v;
  }
  if ("outcome" in body) {
    const v = body.outcome === null ? null : String(body.outcome ?? "");
    if (v !== null && !OUTCOME_VALUES.has(v)) return NextResponse.json({ error: "Unknown outcome." }, { status: 400 });
    patch.outcome = v;
    // A reason only means anything on a disqualification — clear it whenever the outcome moves off it,
    // so a stale "no budget" can't hang off a lead we actually won.
    if (v !== "disqualified") patch.disqualify_reason = null;
  }
  if ("disqualifyReason" in body) {
    const v = body.disqualifyReason === null ? null : String(body.disqualifyReason ?? "");
    if (v !== null && !DISQUALIFY_VALUES.has(v)) return NextResponse.json({ error: "Unknown reason." }, { status: 400 });
    patch.disqualify_reason = v;
  }
  if ("notes" in body) {
    const v = String(body.notes ?? "").trim();
    if (v.length > MAX_NOTES_LEN) return NextResponse.json({ error: "Note is too long." }, { status: 400 });
    patch.notes = v || null;
  }
  // Day-before confirmation tick — dashboard-owned toggle. Deliberately NOT an attendance ruling, so it
  // plays no part in the outcome_set_at computation below (a confirm must never freeze the GHL mirror).
  if ("confirmed" in body) {
    patch.confirmed_at = body.confirmed ? new Date().toISOString() : null;
  }

  const { data: existing } = await r.admin
    .from("lead_meetings")
    .select("id, ghl_appointment_id, attendance, outcome, outcome_set_at")
    .eq("tenant_id", r.tenantId)
    .eq("lead_id", r.id)
    .eq("id", meetingId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Meeting not found." }, { status: 404 });

  // Correcting the attendance can strand a contradictory outcome — "Won" left on a call after the
  // operator realises they didn't turn up. Left in place it is invisible (the UI only offers outcomes
  // valid for the current attendance) yet still counts as "resolved", silently keeping the lead OUT of
  // the rebook queue. Clear anything the new attendance can't carry.
  if (patch.attendance && !("outcome" in body)) {
    const keep = outcomeAppliesTo(patch.attendance as any, (existing.outcome ?? null) as any);
    if (!keep) {
      patch.outcome = null;
      patch.disqualify_reason = null;
    }
  }

  // GoHighLevel FIRST, like every other write in this app, so the two can't diverge. A failure here is
  // reported but does NOT block the local write: the operator's judgement about their own call is worth
  // keeping even when GHL is unreachable, and the mirror won't clobber it (outcome_set_at is set).
  let ghlWarning: string | null = null;
  if (patch.attendance && existing.ghl_appointment_id && ghlConfig()) {
    try {
      await updateAppointmentStatus(existing.ghl_appointment_id, String(patch.attendance));
    } catch (e) {
      console.warn("appointment status write to GHL failed:", e instanceof Error ? e.message : e);
      ghlWarning = "Saved here, but GoHighLevel didn't accept the status change.";
    }
  }

  // outcome_set_at is the sync's ONLY signal that a human has ruled on this meeting, so GHL's calendar
  // mirror must not overwrite the attendance. Stamp it only on a genuine ruling — a terminal attendance
  // (showed / no-show / cancelled) or an outcome — and CLEAR it otherwise. A notes-only edit or a revert
  // back to "scheduled" must NOT freeze the mirror: that let a real no-show silently never reach the
  // rebook queue.
  const finalAttendance = ("attendance" in patch ? patch.attendance : existing.attendance) as string | null;
  const finalOutcome = ("outcome" in patch ? patch.outcome : existing.outcome) as string | null;
  const humanRuling = finalOutcome != null || (!!finalAttendance && finalAttendance !== "scheduled");
  // Keep the ORIGINAL stamp when the ruling itself didn't change: outcome_set_at now also dates the
  // close (Won → revenue day), so a notes edit — or re-clicking the same outcome — on a July-1 won call
  // must not silently move that close (and its revenue/CAC/ROAS) to today.
  const rulingUnchanged = existing.outcome_set_at && finalAttendance === existing.attendance && finalOutcome === existing.outcome;
  patch.outcome_set_at = humanRuling ? (rulingUnchanged ? existing.outcome_set_at : new Date().toISOString()) : null;

  const { data, error } = await r.admin
    .from("lead_meetings")
    .update(patch)
    .eq("tenant_id", r.tenantId)
    .eq("id", meetingId)
    .select("*")
    .maybeSingle();
  if (error || !data) {
    console.error("meetings PATCH failed:", error?.message);
    return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
  }

  // Deal mirror: marking the call Won IS the close — flip the lead's GHL opportunity to won (and onto
  // the pipeline's Won stage); undoing Won reopens it. Best-effort AFTER the local save: the operator's
  // ruling is already recorded, and revenue dating falls back to outcome_set_at when GHL is down. The
  // opportunity is created by Miguel's GHL booking workflow — discovery here also links a lead whose
  // deal the 30-min sync hasn't seen yet.
  const wonNow = finalOutcome === "won" && existing.outcome !== "won";
  const unwonNow = existing.outcome === "won" && finalOutcome !== "won";
  if ((wonNow || unwonNow) && ghlConfig() && r.contactId) {
    try {
      const opps = await fetchOpportunitiesByContact(r.contactId);
      const opp =
        (r.opportunityId ? opps.find((o) => o.id === r.opportunityId) : undefined) ??
        opps.find((o) => o.status === "open") ??
        [...opps].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0] ??
        null;
      if (opp && wonNow) {
        await updateOpportunityStatus(opp.id, "won");
        await moveOpportunityToWonStage(opp);
        // Deliberately NOT writing opportunity_value here: the natural flow is "type the value, then
        // click Won", and the search read above can lag a seconds-old value PUT — writing its (stale,
        // possibly null) monetaryValue would zero the revenue of the close just recorded. Status is
        // this path's job; the sync keeps the value fresh.
        await r.admin
          .from("leads")
          .update({
            ghl_opportunity_id: opp.id,
            opportunity_status: "won",
            opportunity_won_at: r.wonAt ?? new Date().toISOString(),
          })
          .eq("id", r.id);
      } else if (opp && unwonNow) {
        await updateOpportunityStatus(opp.id, "open");
      }
    } catch (e) {
      console.warn("opportunity status write to GHL failed:", e instanceof Error ? e.message : e);
      ghlWarning = ghlWarning ?? "Saved here, but the GoHighLevel opportunity didn't update.";
    }
  }
  // Un-won clears the local close marker (even if the GHL reopen failed) — a lead the operator just
  // un-won must drop out of Closed/Revenue immediately. If GHL really still says won, the next sync
  // re-imposes it and the warning above told the operator something needs a look. Guarded on no OTHER
  // meeting of this lead still being Won: un-winning one call must not erase a close the lead still
  // legitimately has on another (queries counts via that meeting — the two surfaces must agree).
  if (unwonNow) {
    const { data: otherWon } = await r.admin
      .from("lead_meetings")
      .select("id")
      .eq("tenant_id", r.tenantId)
      .eq("lead_id", r.id)
      .eq("outcome", "won")
      .neq("id", meetingId)
      .limit(1);
    if (!otherWon?.length) {
      await r.admin.from("leads").update({ opportunity_status: "open", opportunity_won_at: null }).eq("id", r.id);
    }
  }

  // Rebook-task automation (Miguel, 2026-07-23): a missed call must leave a concrete ACTION behind,
  // not just a queue membership — a lead whose LATEST meeting is a no-show/cancellation with no outcome
  // gets a native GHL task "Call to rebook the meeting" (due in 1h, so it tops today's list); it is
  // completed once they stop owing one (outcome recorded — rebooked or disqualified — or the attendance
  // corrected). RECONCILED, not transition-diffed, against the same lead-level predicate the rebook
  // queue uses (leadNeedsRebooking, latest meeting only): a back-filled ruling on an OLD row can
  // neither spawn a task for an already-rebooked lead nor complete the task a newer miss still owes —
  // and a previously failed complete retries on the next ruling. A NEW booking resolves it via the
  // sync (same predicate there). The title deliberately does NOT match the sync's reach-out
  // auto-complete pattern (/call again|follow up/) — that path judges manual meetings by time alone
  // and was wiping this task while the missed call was still inside its 2h "live" grace.
  if (ghlConfig() && r.contactId && ("attendance" in body || "outcome" in body)) {
    try {
      const { data: allMeetings } = await r.admin
        .from("lead_meetings")
        .select("attendance, outcome, starts_at")
        .eq("tenant_id", r.tenantId)
        .eq("lead_id", r.id);
      const owed = leadNeedsRebooking(
        (allMeetings ?? []).map((m) => ({ attendance: m.attendance, outcome: m.outcome ?? null, startsAt: m.starts_at }))
      );
      const openTasks = await listOpenContactTasks(r.contactId);
      // Exact-title match: our automation's task only. A looser /rebook|remarcar/ once matched (and
      // silently completed) operator-written PT reminders like "Remarcar proposta…".
      const rebookTask = openTasks.find((t) => REBOOK_TASK_RE.test(t.title));
      let touched = false;
      if (owed && !rebookTask) {
        await createContactTask(r.contactId, REBOOK_TASK_TITLE, new Date(Date.now() + 60 * 60_000).toISOString());
        touched = true;
      } else if (!owed && rebookTask) {
        await completeContactTask(r.contactId, rebookTask.id);
        touched = true;
      }
      if (touched) {
        // Refresh the row's task mirror now — the 30-min sync would leave the chip stale/nagging.
        const fresh = await fetchContactOpenTask(r.contactId);
        await r.admin
          .from("leads")
          .update({ ghl_task_id: fresh?.id ?? null, task_title: fresh?.title ?? null, task_due_at: fresh?.dueIso ?? null, task_count: fresh?.openCount ?? 0 })
          .eq("id", r.id);
      }
    } catch (e) {
      // Best-effort: the rebook QUEUE (needsRebook) still owns this state, so a failed task write can
      // never lose the lead — the next attendance/outcome ruling reconciles again.
      console.warn("rebook task automation failed:", e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({ ok: true, meeting: toView(data), ghlWarning });
}
