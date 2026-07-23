import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { isAdminUser } from "@/lib/admin";
import { deleteGhlContact, fetchContactOpenTask, QUAL_WRITE, CALL_WRITE, qualificationFromTags, callStateFromTags, type Qualification, type CallState } from "@/lib/ghl";
import { dateInTz } from "@/lib/time";
import { ghlConfig, ensureField, updateGhlContact, setContactTagState, fetchContactTags, createContactTask, completeContactTask, updateContactTask, deleteContactTask, ADDITIONAL_EMAIL_FIELD, ADDITIONAL_PHONE_FIELD, CALL_ATTEMPTS_FIELD } from "@/lib/ghl-write";
import { companyDomainFromEmail } from "@/lib/email-domain";

export const runtime = "nodejs";
export const maxDuration = 30; // bound a hung GHL/Meta call so it can't hold the function to the platform limit

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254; // RFC 5321 ceiling
const MAX_PHONE_LEN = 32; // digits + formatting; anything longer is garbage, not a phone number
/** Permissive phone check: + ( ) - . space and 6–15 digits, bounded length. */
function validPhone(v: string): boolean {
  if (v.length > MAX_PHONE_LEN) return false;
  if (/[^\d+()\-.\s]/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 15;
}
function validEmail(v: string): boolean {
  return v.length <= MAX_EMAIL_LEN && EMAIL_RE.test(v);
}
const MAX_NAME_LEN = 100;
/** Loose website normalization: strip protocol + trailing slash, lowercase. Null = not a plausible site. */
function normalizeWebsite(v: string): string | null {
  const s = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!s || s.length > 200 || /\s/.test(s) || !s.includes(".")) return null;
  return s;
}

const QUALIFICATIONS = new Set<Qualification>(["qualified", "unqualified", "pending"]);
const CALL_STATES = new Set<CallState>(["none", "contacted", "no_answer", "invalid_phone", "follow_up", "meeting_booked"]);
/** Landing in one of these states means a call was just dialed — it counts as an attempt.
 *  meeting_booked is NOT here: a booking isn't a dial, so it never bumps the attempts count. */
const DIAL_OUTCOMES = new Set<CallState>(["contacted", "no_answer", "invalid_phone"]);

/**
 * Dropping a dead GHL link must also clear everything mirrored FROM that contact: the sync's booked-call/
 * task pass only refreshes LINKED rows, so a stale chip (task, meeting) would otherwise freeze on screen
 * with no way to clear it.
 */
const GHL_UNLINK_PATCH = {
  ghl_contact_id: null,
  ghl_task_id: null,
  task_title: null,
  task_due_at: null,
  ghl_appointment_id: null,
  appointment_at: null,
  appointment_end_at: null,
  appointment_status: null,
  appointment_title: null,
  appointment_link: null,
} as const;

/**
 * True when a GHL error means the CONTACT itself is gone (deleted inside GHL). Classify on the error
 * BODY only — the request path always contains "/contacts/", so matching the whole message would
 * misread GHL's "Task with id … not found" as a dead contact (live-caught 2026-07-19). Both thrown
 * shapes read "GHL <path> <status>: <body>"; the bodies are "Contact with id … not found" vs
 * "Task with id … not found".
 */
function isDeadContactError(msg: string): boolean {
  const body = msg.match(/\s\d{3}:\s([\s\S]*)$/)?.[1] ?? "";
  return /contact/i.test(body) && /not.?found/i.test(body);
}

/** Best-effort mirror of the attempts counter to the GHL "Call Attempts" custom field. The dashboard
 *  column is the source of truth; a failed mirror self-heals on the next increment (absolute value). */
async function mirrorCallAttempts(ghlContactId: string | null, attempts: number): Promise<void> {
  if (!ghlConfig() || !ghlContactId) return;
  try {
    await updateGhlContact(ghlContactId, { customFields: [{ id: await ensureField(CALL_ATTEMPTS_FIELD), value: String(attempts) }] });
  } catch (e: any) {
    console.warn("Call Attempts mirror to GHL failed (will retry on next increment):", e?.message ?? e);
  }
}

/** Manual counter adjustment: +1 = dialed again with the same outcome (a state flip can't record it);
 *  -1 = undo a mis-count. Floored at 0. Dashboard-first — the counter originates here, GHL mirrors it. */
async function logCallAttempt(tenantId: string, id: string, body: Record<string, unknown>): Promise<NextResponse> {
  // Back-compat: `true` means +1; otherwise the value must be exactly 1 or -1.
  const delta = body.logCallAttempt === true ? 1 : Number(body.logCallAttempt);
  if (delta !== 1 && delta !== -1) {
    return NextResponse.json({ ok: false, error: "Invalid attempt adjustment." }, { status: 400 });
  }
  const admin = createAdminClient();
  const { data: lead, error: readErr } = await admin
    .from("leads")
    .select("id, call_attempts, ghl_contact_id")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null) // a soft-deleted lead must not be mutated by a stale second operator
    .maybeSingle();
  if (readErr) {
    console.error("PATCH /api/leads attempt read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load lead." }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
  const attempts = Math.max(0, (lead.call_attempts ?? 0) + delta);
  const { error: upErr } = await admin
    .from("leads")
    // A subtract is a correction, not a call — only a +1 stamps the last-attempt time. The very first
    // dial (0→1) also stamps first_call_at, which is what speed-to-lead measures.
    .update({
      call_attempts: attempts,
      ...(delta > 0 ? { last_call_attempt_at: new Date().toISOString() } : {}),
      ...(delta > 0 && (lead.call_attempts ?? 0) === 0 ? { first_call_at: new Date().toISOString() } : {}),
    })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (upErr) {
    console.error("PATCH /api/leads attempt update failed:", upErr.message);
    return NextResponse.json({ ok: false, error: "Failed to save." }, { status: 500 });
  }
  await mirrorCallAttempts(lead.ghl_contact_id, attempts);
  return NextResponse.json({ ok: true, attempts });
}

const MAX_TASK_TITLE_LEN = 120;

/**
 * Create or complete the lead's GHL task (the follow-up reminder — "Call again" etc.). GHL is the
 * system of record and is written FIRST; the lead's mirror columns are then re-derived by re-reading
 * the contact's next open task, so the row always shows exactly what GHL holds (including an earlier-due
 * task the operator created inside GHL). Requires a linked GHL contact.
 */
async function handleTask(tenantId: string, id: string, body: Record<string, unknown>): Promise<NextResponse> {
  const create = body.createTask as { title?: unknown; dueAt?: unknown } | undefined;
  const completeId = typeof body.completeTask === "string" && body.completeTask.trim() ? body.completeTask.trim() : null;
  const deleteId = typeof body.deleteTask === "string" && body.deleteTask.trim() ? body.deleteTask.trim() : null;
  // Reschedule = same task, new due date. The queue's "push to tomorrow" — previously impossible
  // without delete + re-create, which is why operators deleted reminders instead of moving them.
  const reschedule = body.rescheduleTask as { id?: unknown; title?: unknown; dueAt?: unknown } | undefined;
  if (reschedule) {
    const rid = typeof reschedule.id === "string" ? reschedule.id.trim() : "";
    const rTitle = typeof reschedule.title === "string" ? reschedule.title.trim() : "";
    const rDue = typeof reschedule.dueAt === "string" ? new Date(reschedule.dueAt) : null;
    // Deliberately NO upper bound here (unlike create): the title is GoHighLevel's own, echoed back
    // through the mirror. Rejecting a long one made tasks authored inside GHL permanently
    // un-reschedulable from the dashboard. It is clamped at the write instead.
    if (!rid || !rTitle) {
      return NextResponse.json({ ok: false, error: "Invalid task." }, { status: 400 });
    }
    if (!rDue || isNaN(rDue.getTime()) || rDue.getTime() < Date.now() - 86_400_000 || rDue.getTime() > Date.now() + 400 * 86_400_000) {
      return NextResponse.json({ ok: false, error: "Invalid due date." }, { status: 400 });
    }
  }
  if (create) {
    const title = typeof create.title === "string" ? create.title.trim() : "";
    const dueAt = typeof create.dueAt === "string" ? new Date(create.dueAt) : null;
    if (!title || title.length > MAX_TASK_TITLE_LEN) {
      return NextResponse.json({ ok: false, error: "Invalid task title." }, { status: 400 });
    }
    // Sanity bounds: not further back than yesterday, not more than ~13 months out.
    if (!dueAt || isNaN(dueAt.getTime()) || dueAt.getTime() < Date.now() - 86_400_000 || dueAt.getTime() > Date.now() + 400 * 86_400_000) {
      return NextResponse.json({ ok: false, error: "Invalid due date." }, { status: 400 });
    }
  } else if (!completeId && !deleteId && !reschedule) {
    return NextResponse.json({ ok: false, error: "Invalid task request." }, { status: 400 });
  }
  if (!ghlConfig()) return NextResponse.json({ ok: false, error: "GoHighLevel isn't configured." }, { status: 400 });

  const admin = createAdminClient();
  const { data: lead, error: readErr } = await admin
    .from("leads")
    .select("id, ghl_contact_id")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null) // a soft-deleted lead must not be mutated by a stale second operator
    .maybeSingle();
  if (readErr) {
    console.error("PATCH /api/leads task read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load lead." }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
  if (!lead.ghl_contact_id) {
    return NextResponse.json({ ok: false, error: "Lead isn't linked to a GoHighLevel contact yet." }, { status: 409 });
  }

  try {
    // `next` starts as what the WRITE itself tells us: the created task, or nothing after a complete.
    let next: { id: string; title: string; dueIso: string | null; openCount?: number } | null = null;
    if (create) {
      next = await createContactTask(lead.ghl_contact_id, String(create.title).trim(), new Date(String(create.dueAt)).toISOString());
    } else {
      try {
        if (completeId) await completeContactTask(lead.ghl_contact_id, completeId);
        else if (deleteId) await deleteContactTask(lead.ghl_contact_id, deleteId);
        else {
          next = await updateContactTask(lead.ghl_contact_id, String(reschedule!.id).trim(), {
            // GHL's PUT needs the title alongside the date. It is GHL's OWN title round-tripped back,
            // never operator input, so it is clamped rather than rejected — a long task authored inside
            // GHL must still be reschedulable from here.
            title: String(reschedule!.title).trim().slice(0, MAX_TASK_TITLE_LEN),
            dueIso: new Date(String(reschedule!.dueAt)).toISOString(),
          });
        }
      } catch (e) {
        // A missing task (deleted/completed inside GHL since the last sync) is already the desired end
        // state — fall through to the re-mirror. GHL signals "gone" as 404, as a 400 "Task with id …
        // not found" (complete), or as a 400 "The task id is invalid." (delete — live-probed
        // 2026-07-19). A DEAD CONTACT must escalate (handled below); anything else is a real failure.
        //
        // RESCHEDULE relies on this too: the mirror can be up to 30 min stale, so pushing a task that
        // someone already finished inside GHL must clear the phantom row, not fail forever.
        const msg = e instanceof Error ? e.message : String(e);
        const gone =
          !isDeadContactError(msg) &&
          (/\s404:\s/.test(msg) || (/\s400:\s/.test(msg) && /not found|task id is invalid/i.test(msg)));
        if (!gone) throw e;
        next = null; // the re-read below reports whatever open task really remains
      }
    }
    // Best-effort re-read: another open task may exist (or now be next). The GHL write above already
    // SUCCEEDED, so a failed re-read must not report failure — the UI would invite a retry and create a
    // duplicate task. Fall back to the write's own result; the sync trues it up within 30 min.
    try {
      next = await fetchContactOpenTask(lead.ghl_contact_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isDeadContactError(msg)) throw e;
      console.warn("PATCH /api/leads task re-read failed — mirroring the write's own result:", msg);
    }
    const { error: upErr } = await admin
      .from("leads")
      // openCount is set only by the re-read; if that failed after a create, `next` is the created task
      // so at least 1 open task exists — floor to 1 rather than under-report 0.
      .update({ ghl_task_id: next?.id ?? null, task_title: next?.title ?? null, task_due_at: next?.dueIso ?? null, task_count: next ? (next.openCount ?? 1) : 0 })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (upErr) {
      // GHL accepted the write; the row catches up on the next sync. Report success with the fresh state.
      console.error("PATCH /api/leads task mirror failed:", upErr.message);
    }
    return NextResponse.json({ ok: true, task: next ? { id: next.id, title: next.title, dueAt: next.dueIso, count: next.openCount ?? 1 } : null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("PATCH /api/leads task GHL write failed:", msg);
    if (isDeadContactError(msg)) {
      // Contact deleted inside GHL — same self-heal as the tag/edit flows: drop the stale link (and the
      // now-orphaned mirrored chips) instead of failing this lead forever.
      await admin.from("leads").update(GHL_UNLINK_PATCH).eq("tenant_id", tenantId).eq("id", id);
      return NextResponse.json({ ok: false, error: "This lead's GoHighLevel contact no longer exists." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "GoHighLevel rejected the task change." }, { status: 502 });
  }
}

/**
 * Set a lead's qualification or call state from the Leads tab. The state lives as GoHighLevel tags (so it
 * stays in sync with what the team sees/sets inside GHL); the `leads` columns are a cache the periodic sync
 * re-derives from the same tags. GHL is written FIRST — a rejected tag write blocks the local update, so the
 * two can't diverge. The tag flip removes the opposite tag before adding the new one (see setContactTagState).
 * Requires a linked GHL contact; an unmatched lead has no tag target and returns a clear error.
 */
async function setLeadTagState(tenantId: string, id: string, body: Record<string, unknown>): Promise<NextResponse> {
  const wantQual = "qualification" in body;
  const wantCall = "callState" in body;
  const qualification = body.qualification as Qualification | undefined;
  const callState = body.callState as CallState | undefined;
  if (wantQual && !QUALIFICATIONS.has(qualification as Qualification)) {
    return NextResponse.json({ ok: false, error: "Invalid qualification." }, { status: 400 });
  }
  if (wantCall && !CALL_STATES.has(callState as CallState)) {
    return NextResponse.json({ ok: false, error: "Invalid call state." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: lead, error: readErr } = await admin
    .from("leads")
    .select("id, ghl_contact_id, ghl_tags, call_attempts, tags_updated_at")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null) // a soft-deleted lead must not be mutated by a stale second operator
    .maybeSingle();
  if (readErr) {
    console.error("PATCH /api/leads tag read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load lead." }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
  if (!ghlConfig()) return NextResponse.json({ ok: false, error: "GoHighLevel isn't configured." }, { status: 400 });
  if (!lead.ghl_contact_id) {
    return NextResponse.json(
      { ok: false, error: "This lead isn't linked to a GoHighLevel contact yet — it syncs once the phone matches a contact." },
      { status: 409 }
    );
  }

  // Apply the tag change(s) to GHL, threading the resulting tag list through so a second change in the same
  // request sees the first one's effect. A failure here means nothing is saved locally.
  let tags: string[] = Array.isArray(lead.ghl_tags) ? (lead.ghl_tags as string[]) : [];
  try {
    if (wantQual) {
      const spec = QUAL_WRITE[qualification as Qualification];
      tags = await setContactTagState(lead.ghl_contact_id, tags, { remove: spec.removeAll, add: spec.add });
    }
    if (wantCall) {
      const spec = CALL_WRITE[callState as CallState];
      tags = await setContactTagState(lead.ghl_contact_id, tags, { remove: spec.removeAll, add: spec.add });
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error("PATCH /api/leads tag write failed:", msg);
    if (/not.?found/i.test(msg) && msg.includes("GHL /contacts/")) {
      // Contact deleted inside GHL — drop the stale link so the feature isn't bricked for this lead.
      await admin.from("leads").update(GHL_UNLINK_PATCH).eq("tenant_id", tenantId).eq("id", id);
      return NextResponse.json({ ok: false, error: "This lead's GoHighLevel contact no longer exists." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "GoHighLevel rejected the change — nothing was saved." }, { status: 502 });
  }

  // Re-read GHL's authoritative tags after the write(s): for a remove-only change setContactTagState
  // reconstructs the list from the (possibly stale) cached base, so a concurrent operator's change could
  // otherwise be cached wrong (leads.qualification=pending while GHL holds "qualified"). GHL is the source
  // of truth — cache exactly what it now holds. Best-effort: on a read failure keep the threaded list.
  try {
    tags = await fetchContactTags(lead.ghl_contact_id);
  } catch (e) {
    console.warn("PATCH /api/leads tag re-read failed — caching the threaded list:", e instanceof Error ? e.message : e);
  }

  // Landing in a dial-outcome state (Called / No answer / Invalid) from a different state means a call
  // was just made — count the attempt. Clear-to-none is a correction, not a dial.
  const prevCall = callStateFromTags(Array.isArray(lead.ghl_tags) ? (lead.ghl_tags as string[]) : []);
  const newCall = callStateFromTags(tags);
  const dialed = wantCall && newCall !== prevCall && DIAL_OUTCOMES.has(newCall);
  const attempts = (lead.call_attempts ?? 0) + (dialed ? 1 : 0);

  // Local cache: store the returned tag list plus the re-derived states (so a manually-added variant tag
  // that came back is reflected, not just the button's intent).
  const { error: upErr } = await admin
    .from("leads")
    .update({
      ghl_tags: tags,
      qualification: qualificationFromTags(tags),
      call_state: newCall,
      // The sync compares this stamp against its GHL-snapshot time: a write that lands mid-sync must
      // not be reverted by the pull's stale derivation (last-write-wins race, audit 2026-07-20).
      tags_updated_at: new Date().toISOString(),
      ...(dialed ? { call_attempts: attempts, last_call_attempt_at: new Date().toISOString() } : {}),
      // The FIRST dial (0→1) stamps first_call_at — the speed-to-lead reply moment.
      ...(dialed && (lead.call_attempts ?? 0) === 0 ? { first_call_at: new Date().toISOString() } : {}),
    })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (upErr) {
    console.error("PATCH /api/leads tag cache update failed:", upErr.message);
    return NextResponse.json({ ok: false, error: "GoHighLevel was updated but the dashboard save failed — refresh to reconcile." }, { status: 500 });
  }
  if (dialed) await mirrorCallAttempts(lead.ghl_contact_id, attempts);
  return NextResponse.json({ ok: true, ghlSynced: true, qualification: qualificationFromTags(tags), callState: newCall, attempts });
}

/**
 * Edit a lead's contact info from the Leads tab: correct the phone/email/name (ads sometimes deliver
 * them wrong or mis-cased) and/or set an additional email / additional phone. Name edits carry an
 * explicit first/last split so the operator decides which words are which.
 *
 * Meta re-serves the raw lead on every sync, so corrections can't live in the synced columns —
 * they go to `phone_override`/`email_override`/`first_name_override`/`last_name_override` plus the
 * additional-contact columns, none of which the sync writes. The sync's GHL matching reads
 * phone_override so qualification keeps flowing after a fix.
 *
 * GoHighLevel: phone/email/name update the contact's NATIVE fields; the extras land in the
 * "Additional Email"/"Additional Phone" custom fields (the native additionalEmails array is read-only
 * via the API — highlevel-api-docs #262). GHL is written FIRST: if it rejects the change (e.g. the
 * phone/email belongs to another contact), nothing is saved locally, so the two systems can't diverge.
 * Clearing a value (empty string) reverts contact + row to what Meta originally delivered.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing lead id." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  // Qualification / call-state changes are a SEPARATE, self-contained flow (they mutate GHL tags, not the
  // contact fields), so handle and return before the contact-info logic below. Same for the manual
  // call-attempt "+1" (a dashboard-first counter, mirrored to a GHL custom field).
  if ("logCallAttempt" in body) {
    return logCallAttempt(tenantId, id, body);
  }
  if ("qualification" in body || "callState" in body) {
    return setLeadTagState(tenantId, id, body);
  }
  if ("createTask" in body || "completeTask" in body || "deleteTask" in body || "rescheduleTask" in body) {
    return handleTask(tenantId, id, body);
  }

  // A key that is present is applied; empty string/null clears. Absent keys are untouched.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const clean = (k: string): string | null => {
    const v = body[k];
    const s = typeof v === "string" ? v.trim() : "";
    return s || null;
  };
  // A name edit always arrives as the first/last pair — treat either key as both being present.
  const hasName = has("firstName") || has("lastName");
  if (!has("phone") && !has("email") && !hasName && !has("website") && !has("additionalEmail") && !has("additionalPhone") && !has("company")) {
    return NextResponse.json({ ok: false, error: "Nothing to update." }, { status: 400 });
  }
  const phone = clean("phone");
  const email = clean("email");
  const firstName = clean("firstName");
  const lastName = clean("lastName");
  const websiteRaw = clean("website");
  const website = websiteRaw ? normalizeWebsite(websiteRaw) : null;
  const additionalEmail = clean("additionalEmail");
  const additionalPhone = clean("additionalPhone");
  const company = clean("company");
  if (has("company") && company && company.length > 120) {
    return NextResponse.json({ ok: false, error: "That company name is too long." }, { status: 400 });
  }

  if (has("phone") && phone && !validPhone(phone)) {
    return NextResponse.json({ ok: false, error: "That phone number doesn't look valid." }, { status: 400 });
  }
  if (has("additionalPhone") && additionalPhone && !validPhone(additionalPhone)) {
    return NextResponse.json({ ok: false, error: "That phone number doesn't look valid." }, { status: 400 });
  }
  if (has("email") && email && !validEmail(email)) {
    return NextResponse.json({ ok: false, error: "That email doesn't look valid." }, { status: 400 });
  }
  if (has("additionalEmail") && additionalEmail && !validEmail(additionalEmail)) {
    return NextResponse.json({ ok: false, error: "That email doesn't look valid." }, { status: 400 });
  }
  if (hasName && ((firstName ?? "").length > MAX_NAME_LEN || (lastName ?? "").length > MAX_NAME_LEN)) {
    return NextResponse.json({ ok: false, error: "That name is too long." }, { status: 400 });
  }
  if (has("website") && websiteRaw && !website) {
    return NextResponse.json({ ok: false, error: "That website doesn't look valid." }, { status: 400 });
  }
  const clearingName = hasName && !firstName && !lastName;

  const admin = createAdminClient();
  const { data: lead, error: readErr } = await admin
    .from("leads")
    .select("id, phone, phone_override, email, email_override, website_override, full_name, ghl_contact_id")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null) // a soft-deleted lead must not be mutated by a stale second operator
    .maybeSingle();
  if (readErr) {
    console.error("PATCH /api/leads read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load lead." }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
  if (clearingName && !lead.full_name) {
    return NextResponse.json({ ok: false, error: "This lead has no original name to revert to — type a name instead." }, { status: 400 });
  }
  // Deterministic revert split of Meta's original name (first word / rest) — we don't rely on GHL's own
  // undocumented full-name splitting.
  const revertWords = (lead.full_name ?? "").trim().split(/\s+/).filter(Boolean);

  // 1) GoHighLevel first — a rejected write must block the local save.
  let ghlSynced = false;
  let note: string | null = null;
  if (ghlConfig() && lead.ghl_contact_id) {
    try {
      const customFields: Array<{ id: string; value: string }> = [];
      if (has("additionalEmail")) customFields.push({ id: await ensureField(ADDITIONAL_EMAIL_FIELD), value: additionalEmail ?? "" });
      if (has("additionalPhone")) customFields.push({ id: await ensureField(ADDITIONAL_PHONE_FIELD), value: additionalPhone ?? "" });
      // Website resolution. Explicit edit wins; otherwise an email change re-infers from the new
      // domain (never clearing — free-provider inference is null and the key is omitted, so a
      // manually-curated website in GHL survives). Clearing the website field reverts to the
      // inferred domain, or empties GHL's field when there's nothing to infer.
      const effectiveEmailNow = has("email") ? (email ?? lead.email) : (lead.email_override ?? lead.email);
      const inferredSite = companyDomainFromEmail(effectiveEmailNow);
      const websiteWrite = has("website")
        ? { website: website ?? inferredSite ?? "" }
        : has("email") && inferredSite && !lead.website_override
          ? { website: inferredSite }
          : {};
      await updateGhlContact(lead.ghl_contact_id, {
        // Clearing an override reverts the GHL contact to what Meta originally delivered (when known).
        ...(has("phone") ? { phone: phone ?? lead.phone ?? undefined } : {}),
        ...(has("email") ? { email: email ?? lead.email ?? undefined } : {}),
        // Company mirrors into GHL's NATIVE companyName field; clearing empties it there too.
        ...(has("company") ? { companyName: company ?? "" } : {}),
        ...websiteWrite,
        // Name: set → explicit first/last split (operator decides which words are which).
        //       both cleared → revert to Meta's original full name, split deterministically.
        ...(hasName
          ? firstName || lastName
            ? { firstName: firstName ?? "", lastName: lastName ?? "" }
            : { firstName: revertWords[0] ?? "", lastName: revertWords.slice(1).join(" ") }
          : {}),
        customFields,
      });
      ghlSynced = true;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error("PATCH /api/leads GHL update failed:", msg);
      // Only the contact PUT itself signals a dead link — a "not found" from the customFields endpoint
      // (ensureField) means something else entirely and must NOT drop a valid contact link.
      if (/not.?found/i.test(msg) && msg.includes("GHL /contacts/")) {
        // The contact was deleted inside GHL. Blocking the edit forever on a dead link would brick the
        // feature for this lead — drop the stale link and save locally instead.
        const { error: unlinkErr } = await admin.from("leads").update(GHL_UNLINK_PATCH).eq("tenant_id", tenantId).eq("id", id);
        if (unlinkErr) console.warn("PATCH /api/leads couldn't clear stale ghl_contact_id:", unlinkErr.message);
        note = "Saved here. This lead's GoHighLevel contact no longer exists, so GHL wasn't updated.";
      } else {
        const friendly = /duplicat/i.test(msg)
          ? "GoHighLevel already has another contact with that phone number or email."
          : "GoHighLevel rejected the change — nothing was saved.";
        return NextResponse.json({ ok: false, error: friendly }, { status: 502 });
      }
    }
  } else if (ghlConfig()) {
    note = "Saved here. This lead isn't linked to a GoHighLevel contact yet, so GHL wasn't updated.";
  }

  // 2) Local save. A "corrected" value identical to Meta's original is stored as no-override.
  const patch: Record<string, unknown> = {};
  if (has("phone")) {
    const sameAsOriginal = !!phone && !!lead.phone && phone.replace(/\D/g, "") === String(lead.phone).replace(/\D/g, "");
    patch.phone_override = sameAsOriginal ? null : phone;
  }
  if (has("email")) {
    const sameAsOriginal = !!email && !!lead.email && email.toLowerCase() === String(lead.email).toLowerCase();
    patch.email_override = sameAsOriginal ? null : email;
  }
  if (hasName) {
    patch.first_name_override = firstName;
    patch.last_name_override = lastName;
    // ghl_name caches the GHL contact name from the LAST sync — stale the moment we rename the contact.
    // Null it so the display falls to the override (or, on revert, Meta's full_name) immediately; the
    // next sync re-derives it from GHL, which now carries the same name.
    patch.ghl_name = null;
  }
  if (has("website")) {
    // Identical to the inferred domain → no override needed; the inference keeps providing it.
    const inferredNow = companyDomainFromEmail(lead.email_override ?? lead.email);
    patch.website_override = website && website !== inferredNow ? website : null;
  }
  if (has("additionalEmail")) patch.additional_email = additionalEmail;
  if (has("additionalPhone")) patch.additional_phone = additionalPhone;
  if (has("company")) {
    // Manual value wins over the website extractor forever (its writes are guarded `.is(company, null)`).
    // A CLEAR re-opens auto-extraction after the standard 7-day cooldown — stamping fetched_at now stops
    // the very next sync from instantly re-adding the name the operator just removed.
    patch.company = company;
    patch.company_fetched_at = new Date().toISOString();
  }
  let { error: upErr } = await admin.from("leads").update(patch).eq("tenant_id", tenantId).eq("id", id);
  if (upErr && ghlSynced) {
    // GHL already took the change; leaving phone_override/etc. unsaved would diverge the two systems and,
    // worse, break the sync's GHL match (it reads phone_override). Retry the local write once to ride out
    // a transient DB blip before surfacing the divergence.
    console.warn("PATCH /api/leads local save failed after a successful GHL write — retrying once:", upErr.message);
    ({ error: upErr } = await admin.from("leads").update(patch).eq("tenant_id", tenantId).eq("id", id));
  }
  if (upErr) {
    console.error("PATCH /api/leads update failed:", upErr.message);
    return NextResponse.json(
      { ok: false, error: ghlSynced ? "GoHighLevel was updated but the dashboard save failed — try again." : "Failed to save." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, ghlSynced, note });
}

/**
 * Permanently delete a single lead and make it stay deleted, everywhere.
 *
 * A lead can be re-served forever by Meta's instant form, so a plain row delete would let the next
 * scheduled sync re-import it. Instead we record a durable exclusion (keyed by meta_lead_id) that BOTH
 * sync paths honour — lib/sync/leads.ts (keeps it off the Leads list) and lib/sync/facebook.ts
 * (subtracts it from fb_insights_daily.fb_leads, which is what every leads/CPL/conversion-rate number on
 * the Overview AND Ads-Manager drill-down is computed from). We also decrement that day's stored lead
 * count immediately so the metrics update on the spot instead of waiting for the next sync.
 *
 * Note on CPM: CPM is impressions ÷ spend, not lead-based — deleting a lead does not (and should not)
 * change it. Leads, cost-per-lead, cost-per-result and conversion rate DO update.
 *
 * Admin-only: this mutates numbers the whole team sees.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminUser(user)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing lead id." }, { status: 400 });

  let alsoDeleteGhl = false;
  try {
    const body = await req.json();
    alsoDeleteGhl = !!body?.alsoDeleteGhl;
  } catch {
    /* no body → keep the GHL contact (safe default) */
  }

  const admin = createAdminClient();

  // 1) Load the lead (scoped to this tenant) — we need its Meta id, ad, day and GHL link.
  const { data: lead, error: readErr } = await admin
    .from("leads")
    .select("id, meta_lead_id, fb_ad_id, created_time, source, ghl_contact_id, full_name, deleted_at")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("DELETE /api/leads read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load lead." }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
  // Already soft-deleted (a stale row re-clicked, two tabs, or two admins at once): the exclusion and the
  // fb_leads decrement already happened. A second pass would double-subtract the ad/day lead count — and
  // for a lead older than the facebook sync's backfill window that decrement is NEVER recomputed, so the
  // understated CPL / lead count would stand forever. Mirror the restore path's alreadyLive guard.
  if (lead.deleted_at) return NextResponse.json({ ok: true, alreadyDeleted: true, restorable: true });

  // Account timezone → the calendar day Meta filed this lead under (matches fb_insights_daily.date).
  const { data: acct } = await admin
    .from("ad_accounts")
    .select("timezone_name")
    .eq("tenant_id", tenantId)
    .limit(1)
    .maybeSingle();
  const leadDate = lead.created_time ? dateInTz(lead.created_time, acct?.timezone_name ?? "UTC") : null;
  const isInstantForm = (lead.source ?? "instant_form") === "instant_form";

  // 2) Durable exclusion — this is what keeps the lead gone across future syncs, and carries the
  //    (ad, day) so the insights count stays reduced. Idempotent on (tenant_id, meta_lead_id).
  const { error: exErr } = await admin.from("lead_exclusions").upsert(
    {
      tenant_id: tenantId,
      meta_lead_id: lead.meta_lead_id,
      fb_ad_id: lead.fb_ad_id,
      lead_date: leadDate,
      reason: "deleted from Leads tab",
    },
    { onConflict: "tenant_id,meta_lead_id" }
  );
  if (exErr) {
    console.error("DELETE /api/leads exclusion upsert failed:", exErr.message);
    return NextResponse.json({ ok: false, error: "Failed to record exclusion." }, { status: 500 });
  }

  // 3) Immediately subtract this lead from the stored day/ad count so CPL updates now (only instant-form
  //    leads live in fb_insights_daily.fb_leads; website leads never do). The next facebook sync recomputes
  //    fb_leads = raw − exclusions authoritatively, so this early decrement can't drift.
  if (isInstantForm && lead.fb_ad_id && leadDate) {
    const { data: row } = await admin
      .from("fb_insights_daily")
      .select("fb_leads")
      .eq("tenant_id", tenantId)
      .eq("ad_id", lead.fb_ad_id)
      .eq("date", leadDate)
      .maybeSingle();
    if (row && typeof row.fb_leads === "number") {
      await admin
        .from("fb_insights_daily")
        .update({ fb_leads: Math.max(0, row.fb_leads - 1) })
        .eq("tenant_id", tenantId)
        .eq("ad_id", lead.fb_ad_id)
        .eq("date", leadDate);
    }
  }

  // 4) Hide the row from the Leads list — SOFT delete, so the operator can undo it.
  //    A hard delete destroyed every column the sync never rewrites (phone/email/name overrides,
  //    additional contacts, call_attempts, last_call_attempt_at, notes_count, ghl_pushed_at,
  //    audit_pushed_at, cr_fired_at). Worse, a re-imported lead came back with ghl_pushed_at null,
  //    which re-fires the durable GHL/Slack retry → a duplicate Slack card. Soft delete keeps all of
  //    it, so restore is exact and instant rather than "wait for the next sync and lose the edits".
  const { error: delErr } = await admin
    .from("leads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (delErr) {
    console.error("DELETE /api/leads soft delete failed:", delErr.message);
    return NextResponse.json({ ok: false, error: "Failed to delete lead." }, { status: 500 });
  }

  // 5) Optionally remove the person from GoHighLevel too (off by default — GHL is the CRM system of record).
  let ghlDeleted = false;
  let ghlWarning: string | null = null;
  if (alsoDeleteGhl && lead.ghl_contact_id) {
    const r = await deleteGhlContact(lead.ghl_contact_id);
    ghlDeleted = r.ok;
    if (!r.ok) ghlWarning = "Removed from the dashboard, but couldn't reach GoHighLevel — the contact may still be there.";
  }

  // `restorable` drives the undo affordance: once the GoHighLevel contact itself is deleted, its tags,
  // notes, tasks and appointments are gone for good and no dashboard-side restore can bring them back,
  // so we must not offer an Undo that would silently under-deliver.
  return NextResponse.json({ ok: true, ghlDeleted, ghlWarning, restorable: !ghlDeleted });
}

/**
 * Undo a delete: bring the lead back exactly as it was.
 *
 * The inverse of DELETE, in reverse order — drop the durable exclusion (so neither sync path keeps
 * filtering it), clear deleted_at, and give the day/ad its lead count back so CPL returns to what it
 * was. Because DELETE only soft-deleted, every operator edit (corrected phone, notes count, call
 * attempts, push stamps) is still on the row and comes back with it.
 *
 * Admin-only, mirroring DELETE: it moves numbers the whole team sees.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminUser(user)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing lead id." }, { status: 400 });

  let action = "";
  try {
    const body = await req.json();
    action = String(body?.action ?? "");
  } catch {
    /* no body */
  }
  if (action !== "restore") return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });

  const admin = createAdminClient();

  // Read WITHOUT a deleted_at filter — this is the one path that must see a deleted row.
  const { data: lead, error: readErr } = await admin
    .from("leads")
    .select("id, meta_lead_id, fb_ad_id, created_time, source, deleted_at, full_name")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("restore lead read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load lead." }, { status: 500 });
  }
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
  // Already live — treat as success so a double-click on Undo is harmless.
  if (!lead.deleted_at) return NextResponse.json({ ok: true, alreadyLive: true });

  // 1) Drop the exclusion FIRST. While it exists, the leads sync's step-0 purge and the facebook sync's
  //    fb_leads subtraction both still treat this lead as deleted.
  const { error: exErr } = await admin
    .from("lead_exclusions")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("meta_lead_id", lead.meta_lead_id);
  if (exErr) {
    console.error("restore exclusion delete failed:", exErr.message);
    return NextResponse.json({ ok: false, error: "Failed to clear the exclusion." }, { status: 500 });
  }

  // 2) Un-hide the row.
  const { error: upErr } = await admin
    .from("leads")
    .update({ deleted_at: null })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (upErr) {
    console.error("restore un-delete failed:", upErr.message);
    return NextResponse.json({ ok: false, error: "Failed to restore the lead." }, { status: 500 });
  }

  // 3) Give the day/ad its lead back — the exact inverse of DELETE step 3. Required for leads older
  //    than the facebook sync's backfill window, where fb_insights_daily is never recomputed and the
  //    decrement would otherwise stand forever.
  const { data: acct } = await admin
    .from("ad_accounts")
    .select("timezone_name")
    .eq("tenant_id", tenantId)
    .limit(1)
    .maybeSingle();
  const leadDate = lead.created_time ? dateInTz(lead.created_time, acct?.timezone_name ?? "UTC") : null;
  if ((lead.source ?? "instant_form") === "instant_form" && lead.fb_ad_id && leadDate) {
    const { data: row } = await admin
      .from("fb_insights_daily")
      .select("fb_leads")
      .eq("tenant_id", tenantId)
      .eq("ad_id", lead.fb_ad_id)
      .eq("date", leadDate)
      .maybeSingle();
    if (row && typeof row.fb_leads === "number") {
      await admin
        .from("fb_insights_daily")
        .update({ fb_leads: row.fb_leads + 1 })
        .eq("tenant_id", tenantId)
        .eq("ad_id", lead.fb_ad_id)
        .eq("date", leadDate);
    }
  }

  return NextResponse.json({ ok: true, name: lead.full_name ?? null });
}
