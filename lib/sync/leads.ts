/**
 * Leads sync: pulls every lead off the Page's instant forms (Meta = source of truth for the lead,
 * its ad, contact + answers), then matches each to a GoHighLevel contact by phone to read the
 * qualified/unqualified tag. Upserts into public.leads. Idempotent; safe to run on a schedule.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listPageLeadForms, getLeadsForForm, type MetaLeadRaw } from "../meta-ads";
import { normalizeMetaLead } from "../leads";
import { pushLeadToGhl } from "../ghl-push";
import { pushLeadToAuditIntake, auditIntakeConfigured, auditFormAllowed, getAuditFormIds } from "../audit-intake";
import { ensureShortLabel } from "../question-labels";
import { resolveMetaAnswers } from "../leadform-labels";
import {
  fetchAllGhlContacts,
  indexContacts,
  matchContact,
  qualificationFromTags,
  callStateFromTags,
  fetchContactAppointment,
  fetchAppointmentById,
  fetchAppointmentsByContact,
  type SweepEvent,
  pickRelevantAppointment,
  fetchContactOpenTask,
  fetchContactNotes,
  ghlConfigured,
  QUAL_WRITE,
  CALL_WRITE,
  type Qualification,
  type GhlAppointment,
  type GhlTask,
} from "../ghl";
import { setContactTagState, completeContactTask, fetchOpportunitiesByContact, listGhlFields, updateGhlContact, LEAD_SOURCE_FIELD, type GhlOpportunity } from "../ghl-write";
import { attendanceFromGhl, leadNeedsRebooking, REBOOK_TASK_RE } from "../meetings";
import { companyDomainFromEmail } from "../email-domain";
import { extractCompanyName } from "../company-name";

/** Booking statuses that mean "no call is coming", so the lead must be allowed back into the work
 *  queues. A no-show is the whole point: they owe us a rebook, not silence. */
const DEAD_FOR_QUEUE = new Set(["noshow", "no-show", "cancelled", "canceled", "invalid"]);

/** "Lead Source" dropdown option (lower-cased) → the lead's source classification. ONE system for
 *  source (Miguel, 2026-07-23): the dropdown on the contact, not tags. "Paid Ads" on an imported
 *  contact maps to source "website" so the ads bucket picks it up via channel. */
const ORIGIN_TO_SOURCE: Record<string, { source: string; channel: string; detail: string }> = {
  "cold call": { source: "cold_call", channel: "Cold Call", detail: "Cold outreach" },
  "cold email": { source: "cold_email", channel: "Cold Email", detail: "Cold email outreach" },
  "linkedin dms": { source: "linkedin_dm", channel: "LinkedIn DMs", detail: "LinkedIn outreach" },
  organic: { source: "organic", channel: "Organic", detail: "Organic inbound" },
  referral: { source: "referral", channel: "Referral", detail: "Referred lead" },
  "paid ads": { source: "website", channel: "Paid Ads", detail: "Marked Paid Ads (Lead Source)" },
};
const originValueOf = (c: { customFields?: Record<string, unknown> } | undefined, fieldId: string | null): string =>
  String((fieldId && c?.customFields?.[fieldId]) ?? "")
    .toLowerCase()
    .trim();

export interface LeadsSyncSummary {
  forms: number;
  leadsSeen: number;
  upserted: number;
  ghlConfigured: boolean;
  ghlContacts: number;
  matched: number;
  matchedByEmail: number;
  qualified: number;
  unqualified: number;
  pending: number;
}

/**
 * Capture a single lead (from the realtime webhook) into the leads table immediately, so the Leads
 * tab updates within seconds. Qualification/GHL-match are left for the periodic sync to reconcile —
 * we don't set those columns here, so an existing qualification is preserved on conflict.
 */
export async function captureLead(
  admin: SupabaseClient,
  tenantId: string,
  raw: MetaLeadRaw
): Promise<{
  inserted: boolean;
  alreadyPushed: boolean;
  auditPushedAt: string | null;
  auditUrl: string | null;
  overrides: { phone: string | null; email: string | null; fullName: string | null; website: string | null };
}> {
  const l = normalizeMetaLead(raw);
  // Swap Meta's slugged labels/values for the form's real text ("na_o" → "Não") before anything stores them.
  l.answers = await resolveMetaAnswers(l.answers, l.formId);
  const digits = (l.phone ?? "").replace(/\D/g, "");
  // Was this lead already captured (and already pushed to GHL/n8n / the audit intake)? Lets the webhook
  // skip a duplicate Slack notification on a Meta redelivery (C33) while still retrying a lead whose push
  // previously failed (C29), and skip re-forwarding to the audit intake once delivered. The override
  // columns ride along so a redelivered push uses operator corrections instead of Meta's raw values.
  const { data: existing } = await admin
    .from("leads")
    .select("ghl_pushed_at, audit_pushed_at, audit_url, phone_override, email_override, first_name_override, last_name_override, website_override")
    .eq("tenant_id", tenantId)
    .eq("meta_lead_id", l.metaLeadId)
    .maybeSingle();
  const { error } = await admin.from("leads").upsert(
    {
      tenant_id: tenantId,
      meta_lead_id: l.metaLeadId,
      form_id: l.formId,
      fb_ad_id: l.fbAdId,
      fb_adset_id: l.fbAdsetId,
      fb_campaign_id: l.fbCampaignId,
      ad_name: l.adName,
      channel: "Paid Ads",
      source_detail: l.adName ?? null,
      full_name: l.fullName,
      email: l.email,
      email_norm: l.email ? l.email.toLowerCase().trim() : null,
      phone: l.phone,
      phone_norm: digits || null,
      answers: l.answers,
      created_time: l.createdTime,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,meta_lead_id" }
  );
  if (error) throw new Error(`capture lead upsert failed: ${error.message}`);
  const ex = existing as any;
  const overrideName = [ex?.first_name_override, ex?.last_name_override].filter(Boolean).join(" ");
  return {
    inserted: !existing,
    alreadyPushed: !!existing?.ghl_pushed_at,
    auditPushedAt: ex?.audit_pushed_at ?? null,
    auditUrl: ex?.audit_url ?? null,
    overrides: {
      phone: ex?.phone_override ?? null,
      email: ex?.email_override ?? null,
      fullName: overrideName || null,
      website: ex?.website_override ?? null,
    },
  };
}

/**
 * Atomic single-winner claim for the realtime GHL push. Stamps ghl_pushed_at (only while it is still NULL
 * and the lead isn't deleted) and returns a rollback token ONLY for the caller that won the row — so a Meta
 * redelivery racing the first delivery, or the webhook racing the scheduled retry, can never both fire the
 * GHL/Slack push. Also re-checks deleted_at, closing the exclusion TOCTOU (a delete landing mid-capture
 * cancels the push). A push that then fails calls releaseLeadPushClaim to free the row for the next retry.
 */
export async function claimLeadForPush(admin: SupabaseClient, tenantId: string, metaLeadId: string): Promise<string | null> {
  const stamp = new Date().toISOString();
  const { data } = await admin
    .from("leads")
    .update({ ghl_pushed_at: stamp })
    .eq("tenant_id", tenantId)
    .eq("meta_lead_id", metaLeadId)
    .is("ghl_pushed_at", null)
    .is("deleted_at", null)
    .select("meta_lead_id");
  return data && data.length ? stamp : null;
}

/** Release a push claim (roll ghl_pushed_at back to null) after a failed push — but ONLY if it is still our
 *  stamp, so we never clobber a newer successful claim. Swallows its own errors so it can run in a finally. */
export async function releaseLeadPushClaim(admin: SupabaseClient, tenantId: string, metaLeadId: string, stamp: string): Promise<void> {
  try {
    await admin
      .from("leads")
      .update({ ghl_pushed_at: null })
      .eq("tenant_id", tenantId)
      .eq("meta_lead_id", metaLeadId)
      .eq("ghl_pushed_at", stamp);
  } catch (e) {
    console.warn("releaseLeadPushClaim failed — a failed push may not retry until the next stamp clears:", e instanceof Error ? e.message : e);
  }
}

export async function runLeadsSync(admin: SupabaseClient, tenantId: string): Promise<LeadsSyncSummary> {
  // 0) Permanently-removed leads (operator deleted them). Meta still serves them from the form, so we must
  //    filter them out here or they'd be re-imported every cycle, and purge any row that slipped back in.
  const { data: exRows } = await admin.from("lead_exclusions").select("meta_lead_id").eq("tenant_id", tenantId);
  const excluded = new Set((exRows ?? []).map((r: { meta_lead_id: string }) => r.meta_lead_id));
  if (excluded.size) {
    // `.is("deleted_at", null)` is load-bearing: a soft-deleted lead legitimately carries an exclusion
    // during its undo window, and hard-purging it here would destroy the row the Undo restores. This
    // purge exists only for rows that slipped back in DESPITE an exclusion — those are always live rows.
    await admin
      .from("leads")
      .delete()
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .in("meta_lead_id", Array.from(excluded));
  }

  // 1) Pull all leads from every form on the Page (archived forms keep historical leads).
  const forms = await listPageLeadForms();
  const rawLeads: MetaLeadRaw[] = [];
  for (const f of forms) {
    const leads = await getLeadsForForm(f.id);
    rawLeads.push(...leads);
  }
  const normalized = rawLeads.map(normalizeMetaLead).filter((l) => !excluded.has(l.metaLeadId));
  // Swap Meta's slugged labels/values for the form's real text ("na_o" → "Não", "2_9" → "2–9").
  // Cached per form, so this is one Meta read per form per run — and because the upsert below rewrites
  // every lead's answers each cycle, deploying this retroactively cleans ALL stored leads too.
  for (const l of normalized) l.answers = await resolveMetaAnswers(l.answers, l.formId);

  // 2) Load GHL contacts once and index by phone AND email (skipped gracefully if GHL isn't configured).
  const ghlOn = ghlConfigured();
  // Snapshot moment: any dashboard tag write stamped AFTER this may not be reflected in the contacts
  // pull below — the guard further down keeps the local value instead of reverting it (last-write-wins
  // race, audit finding 2026-07-20). Epoch ms, NOT string compare: Postgres timestamptz serialization
  // ("+00:00", variable fraction digits) makes lexicographic comparison against toISOString() unsound.
  const ghlSnapshotMs = Date.now();
  const contacts = ghlOn ? await fetchAllGhlContacts() : [];

  // Local tag writes that might be newer than the snapshot: keep their stored values this cycle.
  const localTags = new Map<string, { qualification: string | null; call_state: string | null; ghl_tags: unknown; tags_updated_at: string }>();
  for (let start = 0; ; start += 1000) {
    const { data: ltRows, error: ltErr } = await admin
      .from("leads")
      .select("meta_lead_id, qualification, call_state, ghl_tags, tags_updated_at")
      .eq("tenant_id", tenantId)
      .not("tags_updated_at", "is", null)
      .order("id")
      .range(start, start + 999);
    if (ltErr) {
      // Degraded, not fatal: without this map the last-write-wins guard is off for ONE cycle (the
      // race it guards is itself rare). Log loudly rather than kill the whole sync.
      console.warn("localTags load failed — last-write-wins guard degraded this cycle:", ltErr.message);
      break;
    }
    if (!ltRows) break;
    for (const r of ltRows as any[]) {
      if (r.meta_lead_id) localTags.set(r.meta_lead_id, r);
    }
    if (ltRows.length < 1000) break;
  }
  const index = indexContacts(contacts);

  // Operator corrections (Leads tab): phone/email/name. A corrected phone is ALSO written to the GHL
  // contact, so matching must use it — matching on Meta's wrong number would freeze the lead's
  // qualification. When an override exists we deliberately do NOT fall back to Meta's number: the operator
  // declared it wrong, and it may belong to a different real person — a fallback match would link their
  // contact to this lead. Paged like fetchLeadViews: PostgREST caps unpaged reads at 1000 rows silently.
  interface Corrections {
    phone: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    website: string | null;
  }
  const corrections = new Map<string, Corrections>();
  for (let start = 0; ; start += 1000) {
    const { data: ovRows, error: ovErr } = await admin
      .from("leads")
      .select("meta_lead_id, phone_override, email_override, first_name_override, last_name_override, website_override")
      .eq("tenant_id", tenantId)
      .or(
        "phone_override.not.is.null,email_override.not.is.null,first_name_override.not.is.null,last_name_override.not.is.null,website_override.not.is.null"
      )
      .order("meta_lead_id")
      .range(start, start + 999);
    if (ovErr) throw new Error(`lead overrides load failed: ${ovErr.message}`);
    for (const r of (ovRows ?? []) as Array<Record<string, string | null> & { meta_lead_id: string }>) {
      corrections.set(r.meta_lead_id, {
        phone: r.phone_override,
        email: r.email_override,
        firstName: r.first_name_override,
        lastName: r.last_name_override,
        website: r.website_override,
      });
    }
    if (!ovRows || ovRows.length < 1000) break;
  }
  const phoneOverride = new Map<string, string>();
  const emailOverride = new Map<string, string>();
  for (const [mid, c] of corrections) {
    if (c.phone) phoneOverride.set(mid, c.phone);
    if (c.email) emailOverride.set(mid, c.email);
  }
  /** The lead as every outbound push must see it: operator corrections win over Meta's raw values. */
  const withOverride = <
    T extends { metaLeadId: string; phone: string | null; email: string | null; fullName: string | null; websiteOverride?: string | null },
  >(
    l: T
  ): T => {
    const c = corrections.get(l.metaLeadId);
    if (!c) return l;
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
    return {
      ...l,
      phone: c.phone ?? l.phone,
      email: c.email ?? l.email,
      fullName: name || l.fullName,
      websiteOverride: c.website ?? l.websiteOverride,
    };
  };

  // 3) Resolve qualification per lead + build upsert rows.
  //    Matched leads write the GHL-derived columns; UNMATCHED leads omit them entirely so a phone that
  //    didn't resolve this run cannot reset a previously-qualified lead back to "pending" / null the link (C31).
  let matched = 0;
  let matchedByEmail = 0; // of `matched`, how many were linked only because email matched (phone didn't)
  const counts: Record<Qualification, number> = { qualified: 0, unqualified: 0, pending: 0 };
  const now = new Date().toISOString();
  const base = (l: (typeof normalized)[number]) => ({
    tenant_id: tenantId,
    meta_lead_id: l.metaLeadId,
    form_id: l.formId,
    fb_ad_id: l.fbAdId,
    fb_adset_id: l.fbAdsetId,
    fb_campaign_id: l.fbCampaignId,
    ad_name: l.adName,
    channel: "Paid Ads",
    source_detail: l.adName ?? null,
    full_name: l.fullName,
    email: l.email,
    email_norm: l.email ? l.email.toLowerCase().trim() : null,
    phone: l.phone,
    phone_norm: (l.phone ?? "").replace(/\D/g, "") || null,
    answers: l.answers,
    created_time: l.createdTime,
    synced_at: now,
  });
  const matchedRows: Record<string, unknown>[] = [];
  const unmatchedRows: Record<string, unknown>[] = [];
  for (const l of normalized) {
    // Match on the operator-corrected phone/email when present (each also written to the GHL contact),
    // else Meta's raw values. Phone is tried first; email only links leads the phone couldn't (see matchContact).
    const m = matchContact(index, {
      phone: phoneOverride.get(l.metaLeadId) ?? l.phone,
      email: emailOverride.get(l.metaLeadId) ?? l.email,
    });
    if (m) {
      const hit = m.contact;
      // Guard against the snapshot race: a dashboard tag write stamped AFTER the GHL contacts pull
      // began is newer than what the pull saw — writing the pull's derivation would silently revert
      // the operator's click for a cycle (and could double-count attempts on the re-flip). Keep the
      // locally-stored values this cycle; the next pull's snapshot will include the real GHL state.
      const local = localTags.get(l.metaLeadId);
      const localWins = !!local && new Date(local.tags_updated_at).getTime() > ghlSnapshotMs;
      const tags: string[] = localWins && Array.isArray(local.ghl_tags) ? (local.ghl_tags as string[]) : (hit.tags ?? []);
      const qualification: Qualification = localWins
        ? ((local.qualification as Qualification) ?? "pending")
        : qualificationFromTags(hit.tags);
      matched++;
      if (m.via === "email") matchedByEmail++;
      counts[qualification]++;
      matchedRows.push({
        ...base(l),
        ghl_contact_id: hit.id ?? null,
        ghl_name: hit.name ?? null,
        ghl_tags: tags,
        qualification,
        // Re-derive call state from the same tags, so a "contacted"/"no response" tag set in GHL directly
        // (not via the dashboard button) still shows here on the next sync.
        call_state: localWins ? (local.call_state ?? "none") : callStateFromTags(hit.tags ?? []),
        matched_at: now,
      });
    } else {
      // Unknown this run — leave qualification/ghl link untouched on conflict (defaults to "pending" only for brand-new rows).
      counts.pending++;
      unmatchedRows.push(base(l));
    }
  }

  let upserted = 0;
  const upsertChunks = async (rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await admin.from("leads").upsert(chunk, { onConflict: "tenant_id,meta_lead_id" });
      if (error) throw new Error(`leads upsert failed: ${error.message}`);
      upserted += chunk.length;
    }
  };
  await upsertChunks(matchedRows);
  await upsertChunks(unmatchedRows);

  // 3b) Booked-call mirror: for EVERY GHL-linked lead (instant-form AND website — the matching loop
  // above only covers instant forms), pull the contact's calendar appointment and store it. The GHL
  // calendar is the trigger: booking a call there surfaces here on the next sync/Refresh with no manual
  // step. Per-row updates on purpose — a failed read skips the row, so stale data beats a blanked one.
  if (ghlOn) {
    const linked: {
      id: string;
      ghl_contact_id: string;
      qualification: string | null;
      ghl_appointment_id: string | null;
      appointment_at: string | null;
      notes_count: number | null;
      ghl_task_id: string | null;
      task_title: string | null;
      task_due_at: string | null;
      task_count: number | null;
      ghl_opportunity_id: string | null;
      opportunity_value: number | null;
      opportunity_status: string | null;
      opportunity_won_at: string | null;
      notes_cache: unknown;
    }[] = [];
    for (let start = 0; ; start += 1000) {
      const { data: lRows, error: lErr } = await admin
        .from("leads")
        .select("id, ghl_contact_id, qualification, ghl_appointment_id, appointment_at, notes_count, ghl_task_id, task_title, task_due_at, task_count, ghl_opportunity_id, opportunity_value, opportunity_status, opportunity_won_at, notes_cache")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null) // a soft-deleted lead must not be re-tagged or spend GHL reads
        .not("ghl_contact_id", "is", null)
        .order("id") // stable pagination — offset paging without an order can skip/duplicate rows past 1000
        .range(start, start + 999);
      if (lErr || !lRows) break;
      linked.push(...(lRows as typeof linked));
      if (lRows.length < 1000) break;
    }
    const tagsByContact = new Map(contacts.map((c) => [c.id, c.tags]));
    // The "Lead Source" dropdown's field id — source classification reads it off each contact.
    // Unresolvable (listing failed / field deleted) → imports default to cold call this cycle.
    let originFieldId: string | null = null;
    try {
      originFieldId = (await listGhlFields()).find((f) => f.name.trim().toLowerCase() === LEAD_SOURCE_FIELD.toLowerCase())?.id ?? null;
    } catch {
      /* field listing failed — classify with defaults this cycle */
    }
    // PRIMARY appointment source: one events sweep across every calendar (immune to the flaky
    // per-contact list — see fetchAppointmentsByContact). Null = sweep failed → per-contact fallback.
    let sweep: Map<string, SweepEvent[]> | null = null;
    try {
      sweep = await fetchAppointmentsByContact();
      // An ALL-EMPTY sweep is indistinguishable from GHL's calendar-query APIs being down (live-probed
      // 2026-07-20: every calendar and every user returned 0 events while a confirmed booking existed).
      // Don't trust it as "no appointments anywhere" — use the per-contact path so whichever endpoint
      // recovers first resumes discovery; stored bookings survive either way via the by-id verify.
      if (sweep.size === 0) sweep = null;
    } catch (e) {
      console.warn("calendar sweep failed — falling back to per-contact appointment reads:", e instanceof Error ? e.message : e);
    }
    // COLD-CALL BOOKINGS → lead rows. Cold outreach books calls with people who never touched a Meta
    // form, so they have no lead row and the whole call machinery (confirmation queue, Meeting pill,
    // outcomes, tasks) is blind to them. Any swept calendar contact WITHOUT a row becomes a "Cold Call"
    // lead, seeded with its appointment and pushed into `linked` so THIS same pass mirrors it fully.
    if (sweep && sweep.size) {
      try {
        // Contact ids that already have a row — INCLUDING soft-deleted ones: recreating a deleted lead
        // would resurrect it. Paged like every full-table read.
        const known = new Set<string>();
        const coldRows: { id: string; ghl_contact_id: string; source: string | null; created_time: string | null; call_attempts: number | null }[] = [];
        for (let start = 0; ; start += 1000) {
          const { data: rows } = await admin
            .from("leads")
            .select("id, ghl_contact_id, source, created_time, call_attempts")
            .eq("tenant_id", tenantId)
            .not("ghl_contact_id", "is", null)
            .range(start, start + 999);
          if (!rows) break;
          for (const r of rows as { id: string; ghl_contact_id: string; source: string | null; created_time: string | null; call_attempts: number | null }[]) {
            known.add(r.ghl_contact_id);
            if (r.source === "cold_call" || r.source === "cold_email" || r.source === "organic" || r.source === "linkedin_dm" || r.source === "referral") coldRows.push(r);
          }
          if (rows.length < 1000) break;
        }
        const contactById = new Map(contacts.map((c) => [c.id, c]));
        // Cold-row invariants (Miguel's rules): "Submitted" = when the CONTACT entered GoHighLevel
        // (dateAdded), not when this sync first noticed them; and the call counter starts at 1 — the
        // first dial is what created them. Heals the first imports, then no-ops.
        for (const r of coldRows) {
          const patch: Record<string, unknown> = {};
          const added = contactById.get(r.ghl_contact_id)?.dateAdded;
          if (added && Math.abs(new Date(added).getTime() - new Date(r.created_time ?? 0).getTime()) > 5 * 60_000) {
            patch.created_time = added;
          }
          if (r.source === "cold_call" && (r.call_attempts ?? 0) === 0) {
            patch.call_attempts = 1;
            patch.last_call_attempt_at = added ?? new Date().toISOString();
            patch.first_call_at = added ?? new Date().toISOString();
          }
          // Re-classification: the "Lead Source" dropdown is the source of truth — changing it in GHL
          // moves the lead's source here within a cycle (imported rows only; ad leads are never touched:
          // their attribution is Meta's, not a dropdown's).
          const originRaw = originValueOf(contactById.get(r.ghl_contact_id), originFieldId);
          const mapped = ORIGIN_TO_SOURCE[originRaw];
          if (mapped && mapped.source !== r.source) {
            patch.source = mapped.source;
            patch.channel = mapped.channel;
            patch.source_detail = mapped.detail;
          }
          // Empty dropdown on an existing imported row → fill it with the row's current source, so the
          // contact always SHOWS its classification in GHL (one-time per row; next cycle reads it back).
          if (!originRaw && originFieldId && contactById.has(r.ghl_contact_id)) {
            const opt = { cold_call: "Cold Call", cold_email: "Cold Email", linkedin_dm: "LinkedIn DMs", organic: "Organic", referral: "Referral" }[r.source ?? ""];
            if (opt) {
              try {
                await updateGhlContact(r.ghl_contact_id, { customFields: [{ id: originFieldId, value: opt }] });
              } catch {
                /* display-only back-fill */
              }
            }
          }
          if (Object.keys(patch).length) await admin.from("leads").update(patch).eq("id", r.id);
        }
        for (const [contactId, events] of sweep) {
          if (known.has(contactId) || !events.length) continue;
          const c = contactById.get(contactId);
          // Source classification = the contact's "Lead Source" DROPDOWN, the one system for source
          // (Miguel, 2026-07-23 — tags are out). Unset → cold call (the default motion), and the
          // dropdown is filled back so GHL always SHOWS what the dashboard decided.
          const originRaw = originValueOf(c, originFieldId);
          const ob = ORIGIN_TO_SOURCE[originRaw] ?? { source: "cold_call", channel: "Cold Call", detail: "Cold outreach" };
          if (!originRaw && originFieldId) {
            try {
              await updateGhlContact(contactId, { customFields: [{ id: originFieldId, value: "Cold Call" }] });
            } catch {
              /* display-only back-fill — classification already decided */
            }
          }
          // The row's appointment = the soonest upcoming event, else the latest past one (same intent as
          // pickRelevantAppointment); the meeting-history sweep below records ALL of them.
          const nowMs = Date.now();
          const sorted = [...events].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
          const ev = sorted.find((e) => new Date(e.startTime).getTime() > nowMs) ?? sorted[sorted.length - 1];
          const digits = (c?.phone ?? "").replace(/\D/g, "");
          const { data: inserted, error: insErr } = await admin
            .from("leads")
            .insert({
              tenant_id: tenantId,
              meta_lead_id: `ghl:${contactId}`, // synthetic, stable — keeps (tenant, meta_lead_id) unique + delete-exclusion durable
              source: ob.source,
              channel: ob.channel,
              source_detail: ob.detail,
              full_name: c?.name ?? null,
              ghl_name: c?.name ?? null,
              email: c?.email ?? null,
              email_norm: c?.email ? c.email.toLowerCase().trim() : null,
              phone: c?.phone ?? null,
              phone_norm: digits || null,
              ghl_contact_id: contactId,
              // Originates IN GoHighLevel — must never be pushed back to GHL/Slack as a "new lead".
              ghl_pushed_at: new Date().toISOString(),
              // "Submitted" = when the contact entered GHL. For a COLD CALL the first dial is what
              // created them, so its counter starts at 1; other outbound channels weren't dialled yet.
              // Any outbound booking is qualified by definition (Miguel's rule).
              created_time: c?.dateAdded ?? new Date().toISOString(),
              call_attempts: ob.source === "cold_call" ? 1 : 0,
              ...(ob.source === "cold_call"
                ? {
                    last_call_attempt_at: c?.dateAdded ?? new Date().toISOString(),
                    first_call_at: c?.dateAdded ?? new Date().toISOString(),
                    call_state: "contacted",
                  }
                : {}),
              qualification: "qualified",
              synced_at: new Date().toISOString(),
              appointment_at: ev.startTime,
              appointment_end_at: ev.endTime,
              appointment_status: ev.status ?? null,
              appointment_title: ev.title ?? null,
              appointment_link: ev.link ?? null,
              ghl_appointment_id: ev.id,
            })
            .select("id")
            .maybeSingle();
          if (insErr || !inserted) {
            console.warn("cold-call lead insert failed:", insErr?.message ?? "no row returned");
            continue;
          }
          known.add(contactId);
          // Durability: every sync re-derives qualification from the GHL tags, so the "qualified" must
          // live THERE too or the row would flip back to pending. Best-effort; never overrides an
          // explicit disqualified. (The booked-call tag pass below adds meeting_booked the same way.)
          const cTags = tagsByContact.get(contactId) ?? [];
          if (!cTags.some((t: string) => t.toLowerCase().trim() === "disqualified")) {
            try {
              await setContactTagState(contactId, cTags, { remove: QUAL_WRITE.qualified.removeAll, add: QUAL_WRITE.qualified.add });
            } catch {
              /* tag write failed — the row shows qualified now; a later sync retries via the booking pass */
            }
          }
          // Same-cycle machinery: the loop below seeds its lead_meetings history, task/notes mirrors and
          // the booked-call tags exactly like any other linked lead.
          linked.push({
            id: inserted.id as string,
            ghl_contact_id: contactId,
            qualification: null,
            ghl_appointment_id: ev.id,
            appointment_at: ev.startTime,
            notes_count: null,
            ghl_task_id: null,
            task_title: null,
            task_due_at: null,
            task_count: null,
            ghl_opportunity_id: null,
            opportunity_value: null,
            opportunity_status: null,
            opportunity_won_at: null,
            notes_cache: null,
          });
        }
      } catch (e) {
        console.warn("cold-call import failed — Meta leads unaffected:", e instanceof Error ? e.message : e);
      }
    }
    // Two leads can share one contact — fetch each contact's appointment/task once.
    const apptByContact = new Map<string, GhlAppointment | null>();
    const taskByContact = new Map<string, GhlTask | null>();
    const notesByContact = new Map<string, { id: string; body: string; createdAt: string | null }[]>();
    const oppByContact = new Map<string, GhlOpportunity | null>();
    for (const row of linked) {
      try {
        let appt: GhlAppointment | null;
        if (apptByContact.has(row.ghl_contact_id)) {
          appt = apptByContact.get(row.ghl_contact_id) ?? null;
        } else if (sweep) {
          const chosenId = pickRelevantAppointment(sweep.get(row.ghl_contact_id) ?? []);
          appt = chosenId ? await fetchAppointmentById(chosenId) : null;
          // A stored booking is only cleared on EXPLICIT confirmation it's gone: when the sweep had no
          // candidate (booking may live outside the window / in an unlisted calendar), or when the
          // chosen candidate itself resolved dead (it may be a just-cancelled NEWER booking than the
          // stored one — review 2026-07-20), re-verify the stored id before writing nulls.
          if (!appt && row.ghl_appointment_id && row.ghl_appointment_id !== chosenId) {
            appt = await fetchAppointmentById(row.ghl_appointment_id);
          }
          apptByContact.set(row.ghl_contact_id, appt);
        } else {
          // knownId = the stored booking: an empty per-contact list re-verifies it by id instead of
          // clearing (GHL's list endpoint intermittently drops live appointments — see lib/ghl.ts).
          appt = await fetchContactAppointment(row.ghl_contact_id, row.ghl_appointment_id);
          apptByContact.set(row.ghl_contact_id, appt);
        }
        // Meeting HISTORY: every booking this contact has, appended and kept. GHL holds no history of
        // its own — a reschedule edits the event in place and the old slot is gone — so if we don't
        // record it here it is unrecoverable. Rows are only ever upserted, NEVER deleted on an empty
        // read: GHL's calendar endpoints have returned [] for live bookings before (2026-07-19).
        // `outcome_set_at` is the guard that stops the mirror overwriting a human judgement: once the
        // operator says "no-show", GHL's default "confirmed" must never win it back.
        if (sweep) {
          const events = sweep.get(row.ghl_contact_id) ?? [];
          for (const ev of events) {
            try {
              const { data: existing } = await admin
                .from("lead_meetings")
                .select("id, outcome_set_at, starts_at")
                .eq("lead_id", row.id)
                .eq("ghl_appointment_id", ev.id)
                .maybeSingle();
              const base: Record<string, unknown> = {
                tenant_id: tenantId,
                lead_id: row.id,
                ghl_appointment_id: ev.id,
                ghl_contact_id: row.ghl_contact_id,
                starts_at: ev.startTime,
                ends_at: ev.endTime,
                title: ev.title,
                link: ev.link,
                calendar_id: ev.calendarId,
                last_seen_at: now,
                updated_at: now,
              };
              const ghlAttendance = attendanceFromGhl(ev.status);
              if (existing) {
                // A call moved to a DIFFERENT DAY owes a fresh day-before confirmation — the old tick no
                // longer covers it. (Same-day time tweaks keep the confirmation.)
                const dayChanged =
                  !!existing.starts_at && !!ev.startTime &&
                  new Date(existing.starts_at as string).toDateString() !== new Date(ev.startTime).toDateString();
                // Calendar metadata always follows GHL.
                await admin.from("lead_meetings").update(dayChanged ? { ...base, confirmed_at: null } : base).eq("id", existing.id);
                // Attendance follows GHL ONLY until a human has ruled — and the guard lives in the WHERE
                // clause, not just the earlier read, so a ruling committed BETWEEN our select and this
                // write can't be reverted to GHL's default (a TOCTOU race that silently lost the operator's
                // no-show and dropped the lead out of the rebook queue).
                await admin.from("lead_meetings").update({ attendance: ghlAttendance }).eq("id", existing.id).is("outcome_set_at", null);
              } else {
                await admin.from("lead_meetings").insert({ ...base, attendance: ghlAttendance });
              }
            } catch (e) {
              console.warn("meeting history upsert failed:", e instanceof Error ? e.message : e);
            }
          }
        }
        // Manually-entered meetings (a call booked outside GoHighLevel) have no calendar event, so the
        // sweep above can never see them. Seed one history row so they can be ruled on like any other
        // call — without this they sit as a permanent "meeting booked" that nothing can clear.
        if (!row.ghl_appointment_id && row.appointment_at) {
          try {
            // limit(1) + array read, NOT maybeSingle(): maybeSingle errors when 2+ rows match and the
            // error would be swallowed, making duplicates read as "none" and inserting forever. A
            // partial unique index (lead_meetings_manual_uidx) is the real backstop.
            const { data: manualRows, error: manualErr } = await admin
              .from("lead_meetings")
              .select("id")
              .eq("lead_id", row.id)
              .is("ghl_appointment_id", null)
              .limit(1);
            if (manualErr) throw new Error(manualErr.message); // never insert on an unreadable state
            if (!manualRows?.length) {
              await admin.from("lead_meetings").insert({
                tenant_id: tenantId,
                lead_id: row.id,
                ghl_appointment_id: null,
                ghl_contact_id: row.ghl_contact_id,
                starts_at: row.appointment_at,
                title: "Booked outside GoHighLevel",
                last_seen_at: now,
              });
            }
          } catch (e) {
            console.warn("manual meeting seed failed:", e instanceof Error ? e.message : e);
          }
        }
        const patch: Record<string, unknown> = {};
        // Appointment mirror — GHL is the source ONLY for GHL-sourced bookings. Three cases:
        //  • a live GHL appointment → mirror it;
        //  • no GHL appointment but one was stored (ghl_appointment_id set) → the re-verify above
        //    confirmed it's gone → clear;
        //  • no GHL appointment and none was GHL-sourced → LEAVE the columns alone. This preserves a
        //    manually-entered meeting (appointment_at set, ghl_appointment_id null — e.g. a call booked
        //    outside GHL) that the mirror must never blank.
        if (appt) {
          patch.ghl_appointment_id = appt.id;
          patch.appointment_at = appt.startIso;
          patch.appointment_end_at = appt.endIso;
          patch.appointment_status = appt.status;
          patch.appointment_title = appt.title;
          patch.appointment_link = appt.link;
        } else if (row.ghl_appointment_id) {
          patch.ghl_appointment_id = null;
          patch.appointment_at = null;
          patch.appointment_end_at = null;
          patch.appointment_status = null;
          patch.appointment_title = null;
          patch.appointment_link = null;
        }
        // The lead's effective booking after this pass: the live GHL one, else (when no GHL booking was
        // stored) whatever manual appointment is on the row. Drives the auto states below.
        const effectiveApptAt = appt ? appt.startIso : row.ghl_appointment_id ? null : row.appointment_at;
        // The three auto-behaviours below (complete the reach-out task, auto-qualify, auto-tag
        // "meeting booked") all mean "this lead has a call coming". Once outcomes exist that is no
        // longer the same as "this lead has a booking": a meeting that already happened — and
        // especially one they no-showed — must NOT keep suppressing follow-up work forever, or the
        // most valuable lead in the pipeline silently leaves every queue. Only a LIVE, still-upcoming
        // booking that nobody has ruled dead counts.
        const apptIsLive =
          !!effectiveApptAt &&
          new Date(effectiveApptAt).getTime() > Date.now() - 2 * 3_600_000 && // 2h grace: mid-call is still "live"
          !DEAD_FOR_QUEUE.has(String(appt?.status ?? "").toLowerCase());
        // Next open GHL task — the lead's pending to-do ("Call again"). Its OWN try: a failed task read
        // must not gate the appointment mirror or auto-qualify below (which predate the task feature) —
        // the row's stored task columns just stay as they were this cycle.
        try {
          let task: GhlTask | null;
          if (taskByContact.has(row.ghl_contact_id)) {
            task = taskByContact.get(row.ghl_contact_id) ?? null;
          } else {
            task = await fetchContactOpenTask(row.ghl_contact_id);
            taskByContact.set(row.ghl_contact_id, task);
          }
          // A booked meeting means we reached the lead — its "Call again" / "Follow up" reminder is moot,
          // so mark it done in GHL (source of truth). Scoped to the dashboard's own reach-out task titles
          // so an unrelated GHL task is left untouched.
          if (apptIsLive && task && /call again|follow[\s-]?up/i.test(task.title)) {
            try {
              await completeContactTask(row.ghl_contact_id, task.id);
              // Completing the EARLIEST reach-out task can leave OTHERS open (fetchContactOpenTask returns
              // only the head + a total count), so re-read the head rather than hard-nulling — otherwise a
              // remaining task (e.g. an operator's "Send proposal") vanishes from the row until next sync.
              task = await fetchContactOpenTask(row.ghl_contact_id);
              taskByContact.set(row.ghl_contact_id, task);
            } catch {
              /* completion or re-read failed — leave `task`; the next sync reconciles */
            }
          }
          // The auto-created "Call to rebook the meeting" task resolves on the SAME predicate as the
          // rebook queue: once the lead's latest meeting is no longer an unruled miss (they rebooked —
          // a newer booking is now latest — or the miss was ruled in GHL/here), complete it. Deliberately
          // NOT the reach-out path above: that one judges manual meetings by time alone and was wiping
          // this task while the just-missed call still looked "live". Head-task only — a rebook task
          // hiding behind an earlier-due unrelated task waits until it surfaces (bounded staleness).
          if (task && REBOOK_TASK_RE.test(task.title)) {
            try {
              const { data: ms } = await admin
                .from("lead_meetings")
                .select("attendance, outcome, starts_at")
                .eq("lead_id", row.id);
              const stillOwed = leadNeedsRebooking(
                (ms ?? []).map((m: any) => ({ attendance: m.attendance, outcome: m.outcome ?? null, startsAt: m.starts_at }))
              );
              if (!stillOwed) {
                await completeContactTask(row.ghl_contact_id, task.id);
                task = await fetchContactOpenTask(row.ghl_contact_id);
                taskByContact.set(row.ghl_contact_id, task);
              }
            } catch {
              /* read/complete failed — leave the task; the next sync reconciles */
            }
          }
          // Task-column mirror is a compare-and-swap, NOT part of `patch`: this loop runs for minutes, so
          // an operator who completes/reschedules a task mid-sync has already moved the stored ghl_task_id
          // past the value we read when this row was loaded. Writing ours unconditionally would clobber it
          // — worst case resurrecting a just-completed task back into the work queue. The
          // .eq(ghl_task_id, <loaded>) makes the write a no-op whenever anyone touched the task since.
          const changed =
            (task?.id ?? null) !== (row.ghl_task_id ?? null) ||
            (task?.title ?? null) !== (row.task_title ?? null) ||
            (task?.dueIso ?? null) !== (row.task_due_at ?? null) ||
            (task?.openCount ?? 0) !== (row.task_count ?? 0);
          if (changed) {
            const tq = admin
              .from("leads")
              .update({ ghl_task_id: task?.id ?? null, task_title: task?.title ?? null, task_due_at: task?.dueIso ?? null, task_count: task?.openCount ?? 0 })
              .eq("id", row.id);
            await (row.ghl_task_id == null ? tq.is("ghl_task_id", null) : tq.eq("ghl_task_id", row.ghl_task_id));
          }
        } catch {
          /* task read/write failed — keep the row's stored task columns */
        }
        // Note-chip mirror: leads.notes_count exists ONLY so a row can show "this lead has notes"
        // without opening it. The notes route reconciles it whenever notes are read/added/deleted in the
        // dashboard, but a note written directly inside GHL touches nothing here — the chip would stay
        // dark until someone happened to open that contact. Counting notes each sync makes the chip
        // authoritative within one cycle (~30 min). One extra GHL read per unique linked contact, in its
        // OWN try so a notes outage can't gate the appointment/task mirrors above.
        try {
          let contactNotes: { id: string; body: string; createdAt: string | null }[];
          if (notesByContact.has(row.ghl_contact_id)) {
            contactNotes = notesByContact.get(row.ghl_contact_id)!;
          } else {
            contactNotes = (await fetchContactNotes(row.ghl_contact_id)) as { id: string; body: string; createdAt: string | null }[];
            notesByContact.set(row.ghl_contact_id, contactNotes);
          }
          const notesCount = contactNotes.length;
          // Compare-and-swap, NOT part of `patch`: this loop runs for minutes, so an operator adding or
          // deleting a note mid-sync would already have moved the stored count past our reading — writing
          // ours would clobber it (worst case blanking a just-added note's chip for a cycle). The
          // `.eq(notes_count, snapshot)` makes the write a no-op whenever anyone else touched it since.
          // notes_cache (the popup's instant-open seed) rides the same guarded write; a note EDITED in
          // GHL with an unchanged count stays stale here until the next popup open reconciles it.
          // `row.notes_cache == null` also triggers the write: a contact whose count never changes would
          // otherwise NEVER get its cache filled and its popup would load slow forever (Miguel, 23 Jul).
          if (notesCount !== (row.notes_count ?? 0) || row.notes_cache == null) {
            const q = admin
              .from("leads")
              .update({ notes_count: notesCount, notes_cache: contactNotes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt ?? null })) })
              .eq("id", row.id);
            // `.eq(col, null)` never matches in SQL — a row predating the column needs an IS NULL guard.
            await (row.notes_count === null ? q.is("notes_count", null) : q.eq("notes_count", row.notes_count));
          }
        } catch {
          /* notes read failed — keep the row's stored count; the next sync retries */
        }
        // Opportunity mirror: a GHL WORKFLOW creates the opportunity when a call gets booked (Miguel's
        // setup, 2026-07-22) — the dashboard never creates one. Here we DISCOVER it by contact, link it
        // (ghl_opportunity_id), and keep value/status fresh; GHL is the source of truth for both. Only
        // leads with any meeting signal spend the read — opportunity-less leads cost nothing. Own try so
        // an opportunities outage can't gate the mirrors above/below. NEVER unlinked on an empty read
        // (same conservatism as appointments: an API blip must not orphan a linked deal).
        try {
          const hasMeetingSignal =
            !!row.ghl_opportunity_id || !!row.ghl_appointment_id || !!row.appointment_at || !!(sweep?.get(row.ghl_contact_id)?.length);
          if (hasMeetingSignal) {
            let opp: GhlOpportunity | null;
            const fromCache = oppByContact.has(row.ghl_contact_id);
            if (fromCache) {
              opp = oppByContact.get(row.ghl_contact_id) ?? null;
            } else {
              const opps = await fetchOpportunitiesByContact(row.ghl_contact_id);
              // Prefer the already-linked one; else the open one; else the newest — a contact should
              // only ever have one live deal, but GHL doesn't enforce that.
              opp =
                (row.ghl_opportunity_id ? opps.find((o) => o.id === row.ghl_opportunity_id) : undefined) ??
                opps.find((o) => o.status === "open") ??
                [...opps].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0] ??
                null;
              oppByContact.set(row.ghl_contact_id, opp);
            }
            // A cache hit carries the FIRST-processed row's preference. If THIS row is explicitly linked
            // to a different opportunity (multi-deal contact, one deal per lead), keep its own link —
            // never cross-relink two leads onto one deal.
            if (opp && fromCache && row.ghl_opportunity_id && opp.id !== row.ghl_opportunity_id) opp = null;
            if (opp) {
              // Close date: stamped on the first sync that sees status=won (the dashboard's own Won
              // click stamps it earlier); cleared if the deal is reopened or lost.
              const wonAt = opp.status === "won" ? (row.opportunity_won_at ?? new Date().toISOString()) : null;
              const changed =
                opp.id !== row.ghl_opportunity_id ||
                (opp.monetaryValue ?? null) !== (row.opportunity_value == null ? null : Number(row.opportunity_value)) ||
                opp.status !== (row.opportunity_status ?? null) ||
                wonAt !== (row.opportunity_won_at ?? null);
              if (changed) {
                // Compare-and-swap on the value snapshot (mirrors the task/notes guards): an operator
                // typing a deal value mid-sync must not have it clobbered by our (possibly pre-edit) GHL
                // read. No-op on conflict; the next cycle reconciles from GHL truth.
                const q = admin
                  .from("leads")
                  .update({ ghl_opportunity_id: opp.id, opportunity_value: opp.monetaryValue, opportunity_status: opp.status, opportunity_won_at: wonAt })
                  .eq("id", row.id);
                await (row.opportunity_value == null ? q.is("opportunity_value", null) : q.eq("opportunity_value", row.opportunity_value));
              }
            }
          }
        } catch {
          /* opportunity read failed — keep the stored link/value; the next sync retries */
        }
        // Booking a Meet IS the qualification moment (qualified = made it to a Google Meet), so a
        // still-pending lead with a booking gets the `qualified` tag automatically. Never flips an
        // explicit `unqualified`, and never touches a post-meet `disqualified` contact — that stage
        // belongs to the team, inside GHL.
        const tags = tagsByContact.get(row.ghl_contact_id) ?? [];
        if (apptIsLive && (row.qualification ?? "pending") === "pending" && !tags.some((t) => t.toLowerCase().trim() === "disqualified")) {
          // `row.qualification` and `tags` are from BEFORE this loop started, and the loop runs for
          // minutes — an operator's mid-loop Unqualify would be reversed by a tag write computed from
          // the stale list (review 2026-07-20). Re-read the row fresh; only a still-pending lead
          // auto-qualifies. Shrinks the race to sub-second.
          const { data: freshRow } = await admin.from("leads").select("qualification").eq("id", row.id).maybeSingle();
          if ((freshRow?.qualification ?? "pending") === "pending") {
            try {
              await setContactTagState(row.ghl_contact_id, tags, {
                remove: QUAL_WRITE.qualified.removeAll,
                add: QUAL_WRITE.qualified.add,
              });
              patch.qualification = "qualified";
            } catch {
              /* tag write failed — the booking still displays; the next sync retries the tag */
            }
          }
        }
        // Any lead with a booking (GHL or manually entered) auto-gets the "Meeting booked" call state —
        // the operator shouldn't log it by hand. Gate is the ABSENCE of the GHL tag (callStateFromTags
        // returns meeting_booked only when the tag is present): once written it stops, so no needless
        // re-writes. A booked lead is authoritative — this deliberately overrides an earlier call state
        // (e.g. Paulo/João were "contacted" before booking). Clearing is by CANCELLATION only: the
        // meeting disappears from GHL → the mirror stops re-applying and the operator moves it on.
        if (apptIsLive && callStateFromTags(tags) !== "meeting_booked") {
          try {
            await setContactTagState(row.ghl_contact_id, tags, {
              remove: CALL_WRITE.meeting_booked.removeAll,
              add: CALL_WRITE.meeting_booked.add,
            });
            patch.call_state = "meeting_booked";
          } catch {
            /* tag write failed — the booking chip still shows; the next sync retries the tag */
          }
        }
        if (Object.keys(patch).length) await admin.from("leads").update(patch).eq("id", row.id);
      } catch {
        /* appointment read failed — keep whatever was stored for this lead */
      }
    }
  }

  // COMPANY NAMES from websites: for leads with a known site (operator-set website override, else the
  // domain inferred from a professional email) and no extracted company yet, fetch the homepage and
  // pull the name (lib/company-name.ts heuristics — og:site_name / JSON-LD / title / domain; no AI).
  // Time-budgeted and failure-cooldowned (7d) so dead sites can't stall a cycle or get hammered forever.
  try {
    const COMPANY_BUDGET_MS = 25_000;
    const companyStart = Date.now();
    const retryBefore = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data: companyRows } = await admin
      .from("leads")
      .select("id, email, email_override, website_override")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .is("company", null)
      .or(`company_fetched_at.is.null,company_fetched_at.lt.${retryBefore}`)
      .limit(200);
    for (const r of companyRows ?? []) {
      if (Date.now() - companyStart > COMPANY_BUDGET_MS) break; // out of budget — the next cycle continues
      const site = (r.website_override as string | null) ?? companyDomainFromEmail((r.email_override as string | null) ?? (r.email as string | null));
      if (!site) continue; // no known website — nothing to stamp; picked up whenever one appears
      const company = await extractCompanyName(site);
      // `.is(company, null)`: never clobber a name someone set while this loop ran.
      await admin.from("leads").update({ company, company_fetched_at: new Date().toISOString() }).eq("id", r.id).is("company", null);
    }
  } catch (e) {
    console.warn("company extraction failed:", e instanceof Error ? e.message : e);
  }

  // The step-0 exclusion snapshot is MINUTES old by now (the GHL contact pull + per-form Meta pulls sit in
  // between) — a lead the operator deleted mid-sync would still be in `normalized` and could be re-pushed /
  // audit-forwarded after its deletion. Re-read exclusions fresh and honour them in BOTH retry blocks below.
  const { data: freshExRows } = await admin.from("lead_exclusions").select("meta_lead_id").eq("tenant_id", tenantId);
  const freshExcluded = new Set((freshExRows ?? []).map((r: { meta_lead_id: string }) => r.meta_lead_id));

  // Durable retry — audit intake: forward a RECENT instant-form lead whose audit-intake push failed
  // (audit_pushed_at IS NULL). Runs BEFORE the GHL/Slack retry so a retried Slack card already carries the
  // audit link. Same 6h recency bound as the GHL retry: an old lead re-imported from Meta must NEVER
  // retroactively trigger an audit email. The intake endpoint is idempotent on lead_id (their DB unique
  // index), so a webhook/sync overlap can't generate a second audit. Time-budgeted so an audit-service
  // outage can NEVER starve the GHL/Slack retry below (the sync runs every ~30min — leftovers wait a cycle).
  if (auditIntakeConfigured()) {
    const AUDIT_RETRY_BUDGET_MS = 30_000;
    const auditRetryStart = Date.now();
    const retryCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: unforwarded } = await admin
      .from("leads")
      .select("meta_lead_id")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null) // never forward a lead the operator deleted
      .eq("source", "instant_form")
      .is("audit_pushed_at", null)
      .gte("created_time", retryCutoff)
      .limit(200);
    const needIds = new Set((unforwarded ?? []).map((r: { meta_lead_id: string }) => r.meta_lead_id));
    if (needIds.size) {
      const auditFormIds = await getAuditFormIds(admin, tenantId); // forms flagged is_audit (+ launched)
      const byId = new Map(normalized.map((l) => [l.metaLeadId, l]));
      for (const mid of needIds) {
        if (Date.now() - auditRetryStart > AUDIT_RETRY_BUDGET_MS) break; // out of budget — next sync continues
        if (freshExcluded.has(mid)) continue; // deleted mid-sync — never forward
        const lead = byId.get(mid);
        if (!lead) continue; // not in the current Meta pull; a later run will catch it
        if (!auditFormAllowed(lead.formId, auditFormIds)) continue; // only designated audit forms forward (skip generic lead-gen forms)
        const r = await pushLeadToAuditIntake(withOverride(lead), { attempts: 1, timeoutMs: 8_000 });
        if (r.ok) {
          await admin
            .from("leads")
            .update({ audit_pushed_at: new Date().toISOString(), audit_url: r.auditUrl })
            .eq("tenant_id", tenantId)
            .eq("meta_lead_id", mid);
        }
        // On failure: leave audit_pushed_at null → retried next sync (within the 6h window).
      }
    }
  }

  // Durable retry (C29): re-push an instant-form lead the realtime webhook captured but failed to deliver
  // to GHL/n8n (ghl_pushed_at IS NULL).
  //
  // This window used to be 6h, which silently ABANDONED leads: the custom-field bug (2026-07-16) ran ~14h
  // overnight, so 4 of 5 dropped leads aged out of the retry and would have been lost forever — they needed
  // a manual push. A failed lead must outlive an outage that spans a night or a weekend.
  //
  // It is NOT the guard against re-pushing a deleted lead — that's covered three ways over: step 0 purges
  // excluded rows from `leads` every sync, `freshExcluded` re-checks mid-sync, and the delete route fails
  // closed (it refuses to delete unless the exclusion is recorded first). The window's real job is narrower:
  // stop a bulk of ANCIENT never-pushed leads (e.g. a form connected long after the GHL integration, or a
  // backfill) from suddenly flooding GHL + Slack. 7 days covers any outage worth surviving while keeping
  // that blast radius bounded.
  let rePushed = 0;
  if (ghlOn) {
    const retryCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: unpushed } = await admin
      .from("leads")
      .select("meta_lead_id, audit_url, ghl_contact_id")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null) // never re-push a lead the operator deleted
      .eq("source", "instant_form")
      .is("ghl_pushed_at", null)
      .gte("created_time", retryCutoff)
      .limit(200);
    const auditUrlById = new Map((unpushed ?? []).map((r: { meta_lead_id: string; audit_url: string | null }) => [r.meta_lead_id, r.audit_url]));
    const linkedById = new Map((unpushed ?? []).map((r: { meta_lead_id: string; ghl_contact_id: string | null }) => [r.meta_lead_id, r.ghl_contact_id]));
    const needIds = new Set((unpushed ?? []).map((r: { meta_lead_id: string }) => r.meta_lead_id));
    if (needIds.size) {
      const byId = new Map(normalized.map((l) => [l.metaLeadId, l]));
      for (const mid of needIds) {
        if (freshExcluded.has(mid)) continue; // deleted mid-sync — never re-push to GHL/Slack
        const lead = byId.get(mid);
        if (!lead) continue; // not in the current Meta pull; a later run will catch it
        // Claim the row before pushing so this scheduled retry can't race the realtime webhook into a
        // duplicate Slack (whoever wins `ghl_pushed_at IS NULL` pushes; the other no-ops). Always released
        // when the push doesn't land, so a genuinely stuck lead is retried next cycle.
        const claim = await claimLeadForPush(admin, tenantId, mid);
        if (!claim) continue;
        let ok = false;
        try {
          await Promise.all(
            lead.answers.map(async (a) => {
              a.shortLabel = (await ensureShortLabel(admin, tenantId, a.label)) ?? undefined;
            })
          );
          // Push with the corrected phone (withOverride): re-pushing Meta's raw number would revert an
          // operator's fix on the GHL contact (upsert dedupes by email) or create the contact wrong.
          const pushed = await pushLeadToGhl(withOverride(lead), { auditUrl: auditUrlById.get(mid) ?? null });
          if (pushed.ok) {
            // Mark delivered BEFORE the contact-id write, mirroring the webhook: a delivered lead must not
            // be released (and re-pushed → duplicate Slack) just because the follow-up contact-id update
            // throws. The claim already stamped ghl_pushed_at.
            rePushed++;
            ok = true;
            // Link the contact NOW (when not already linked): with a phone override in play, the phone-based
            // matcher above may never see this contact, so the retry is the only reliable link source.
            if (pushed.contactId && !linkedById.get(mid)) {
              await admin.from("leads").update({ ghl_contact_id: pushed.contactId }).eq("tenant_id", tenantId).eq("meta_lead_id", mid);
            }
          }
        } catch {
          /* fall through to release the claim below */
        }
        if (!ok) await releaseLeadPushClaim(admin, tenantId, mid, claim);
      }
    }
  }
  void rePushed;

  // Stamp completion LAST, so it means "a full leads sync finished", not "some row was touched".
  // This is what the Leads tab's freshness indicator reads; leads.synced_at can't serve that purpose
  // because the realtime webhook and the website route stamp it on a single inbound row.
  try {
    await admin
      .from("sync_state")
      .upsert({ tenant_id: tenantId, kind: "leads", last_success_at: new Date().toISOString() }, { onConflict: "tenant_id,kind" });
  } catch (e) {
    console.warn("sync_state stamp failed:", e instanceof Error ? e.message : e);
  }

  return {
    forms: forms.length,
    leadsSeen: normalized.length,
    upserted,
    ghlConfigured: ghlOn,
    ghlContacts: index.count,
    matched,
    matchedByEmail,
    qualified: counts.qualified,
    unqualified: counts.unqualified,
    pending: counts.pending,
  };
}
