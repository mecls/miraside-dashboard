/** Server-side loader: reads stored leads and joins each to its ad's thumbnail for the CRM view. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadAnswer, LeadView, Qualification, CallState } from "./leads";
import { companyDomainFromEmail } from "./email-domain";
import { awaitingOutcome, leadNeedsRebooking } from "./meetings";

/**
 * When the leads data was last pulled. The sidebar's "synced Nm ago" reads
 * connections.last_synced_at, which ONLY the Facebook/ad-spend sync writes, so it can say "28m ago"
 * seconds after a successful leads refresh. The Leads tab needs its own answer, and leads.synced_at
 * (stamped on every row by both the webhook capture and the sync) already is it.
 */
export async function fetchLeadsSyncedAt(admin: SupabaseClient, tenantId: string): Promise<string | null> {
  // sync_state, NOT max(leads.synced_at): the realtime webhook and the website lead route stamp
  // synced_at on the single row they write, so one inbound lead would make the tab claim it had just
  // synced when nothing had been checked. sync_state is written only when a full run completes.
  const { data } = await admin
    .from("sync_state")
    .select("last_success_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "leads")
    .maybeSingle();
  return (data?.last_success_at as string | null) ?? null;
}

export async function fetchLeadViews(admin: SupabaseClient, tenantId: string): Promise<LeadView[]> {
  // Page through .range() so the CRM + its qualification tallies cover the full leads table rather than
  // the newest 1000 (PostgREST's default response cap) once the tenant accumulates >1000 leads (N-leads).
  const cols =
    "id, meta_lead_id, created_time, full_name, ghl_name, first_name_override, last_name_override, email, email_override, website_override, phone, phone_override, additional_email, additional_phone, fb_ad_id, fb_adset_id, ad_name, fb_campaign_id, channel, qualification, call_state, call_attempts, last_call_attempt_at, ghl_contact_id, answers, source, stage, audit_url, appointment_at, appointment_end_at, appointment_status, appointment_title, appointment_link, ghl_appointment_id, ghl_task_id, task_title, task_due_at, task_count, notes_count, notes_cache, ghl_opportunity_id, opportunity_value, opportunity_status, company";
  const rows: any[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("leads")
      .select(cols)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null) // soft-deleted leads are hidden here but kept, so a delete can be undone
      .order("created_time", { ascending: false, nullsFirst: false })
      .range(start, start + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  // Missed calls that still owe a rebook, and duplicate people.
  //
  // needsRebook drives the recovery queue: a lead who no-showed or cancelled and has had no outcome
  // recorded since. Without this a booking — ANY booking, including one they ghosted — took the lead
  // off every work list permanently, quietly losing the most valuable leads in the pipeline.
  const rebook = new Set<string>();
  const awaiting = new Set<string>();
  const meetingCount = new Map<string, number>();
  const latestMeeting = new Map<string, { attendance: any; outcome: any; confirmedAt: any }>();
  // Verdict of the SPECIFIC meeting the row's appointment mirror points at (keyed lead → appt id).
  // The chip renders leads.appointment_at, which pickRelevantAppointment derives SKIPPING dead
  // bookings — while latestMeeting above is latest-by-time INCLUDING them. When a future booking got
  // cancelled after an earlier live one, the two named different meetings and the chip showed the live
  // call dressed in the cancelled one's verdict (review find, 2026-07-23).
  const apptVerdict = new Map<string, Map<string, { attendance: any; confirmedAt: any }>>();
  {
    const byLead = new Map<string, { attendance: any; outcome: any; startsAt: string; confirmedAt: any }[]>();
    // Paged like the leads read above: PostgREST silently caps an unpaged select at 1000 rows, and a
    // truncated read here would quietly drop leads out of the no-show recovery queue with no error.
    const ms: any[] = [];
    for (let start = 0; ; start += 1000) {
      const { data: page } = await admin
        .from("lead_meetings")
        .select("lead_id, attendance, outcome, starts_at, confirmed_at, ghl_appointment_id")
        .eq("tenant_id", tenantId)
        .order("id")
        .range(start, start + 999);
      if (!page) break;
      ms.push(...page);
      if (page.length < 1000) break;
    }
    for (const m of ms) {
      meetingCount.set(m.lead_id, (meetingCount.get(m.lead_id) ?? 0) + 1);
      const arr = byLead.get(m.lead_id);
      const item = { attendance: m.attendance, outcome: m.outcome, startsAt: m.starts_at, confirmedAt: m.confirmed_at };
      if (arr) arr.push(item);
      else byLead.set(m.lead_id, [item]);
      if (m.ghl_appointment_id) {
        const inner = apptVerdict.get(m.lead_id) ?? new Map();
        inner.set(String(m.ghl_appointment_id), { attendance: m.attendance, confirmedAt: m.confirmed_at });
        apptVerdict.set(m.lead_id, inner);
      }
    }
    // Judged on the LATEST meeting only — see leadNeedsRebooking. Testing "any missed meeting ever"
    // would pin a lead who no-showed and was then rebooked at the top of the queue forever.
    for (const [leadId, ms2] of byLead) {
      if (leadNeedsRebooking(ms2)) rebook.add(leadId);
      // The latest meeting's verdict also picks the right WhatsApp template (no-show → "estive à
      // espera", cancelled → "quando remarcamos").
      const latest = ms2.reduce((a, b) => (new Date(b.startsAt).getTime() > new Date(a.startsAt).getTime() ? b : a));
      latestMeeting.set(leadId, { attendance: latest.attendance, outcome: latest.outcome, confirmedAt: latest.confirmedAt });
      // A call whose time has passed but which GHL still reports as scheduled owes a "did they show?"
      // verdict — keep it on the worklist (queueBucket's "awaiting" bucket) instead of letting it
      // silently leave every queue.
      if (awaitingOutcome({ attendance: latest.attendance, startsAt: latest.startsAt })) awaiting.add(leadId);
    }
  }

  // One human, several submissions: the same person filling the form twice, or coming in once via the
  // ad form and once via the website. Matched on normalised phone first, then email — the same keys the
  // GoHighLevel matcher uses. Flagging them stops one booked meeting reading as two wins.
  const dupeOf = new Map<string, number>();
  {
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      const keys = [
        (r.phone_override ?? r.phone) ? String(r.phone_override ?? r.phone).replace(/\D/g, "").slice(-9) : null,
        (r.email_override ?? r.email) ? String(r.email_override ?? r.email).trim().toLowerCase() : null,
      ].filter((k): k is string => !!k && k.length > 3);
      for (const k of keys) {
        const arr = byKey.get(k);
        if (arr) arr.push(r.id);
        else byKey.set(k, [r.id]);
      }
    }
    for (const ids of byKey.values()) {
      if (ids.length < 2) continue;
      const unique = [...new Set(ids)];
      if (unique.length < 2) continue;
      for (const id of unique) dupeOf.set(id, Math.max(dupeOf.get(id) ?? 0, unique.length));
    }
  }

  // GoHighLevel deep-link base (contact detail page). Location id is non-secret config.
  const ghlLocation = process.env.GHL_LOCATION_ID;
  const ghlUrl = (contactId: string | null) =>
    ghlLocation && contactId ? `https://app.gohighlevel.com/v2/location/${ghlLocation}/contacts/detail/${contactId}` : null;
  // GHL stores names lower-cased; present them cleanly capitalised (accents preserved).
  const titleCase = (s: string) => s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));

  // Hydrate ad name + thumbnail from the synced ads table where available. Unpaged .in() is safe here:
  // the response is one row per matched ad, bounded by the account's distinct ad count (~dozens), far
  // under PostgREST's 1000-row cap. If this ever became a multi-thousand-ad account, page these too.
  const adIds = [...new Set(rows.map((r) => r.fb_ad_id).filter(Boolean) as string[])];
  const adInfo = new Map<string, { name: string | null; thumb: string | null; image: string | null; createdAt: string | null; status: string | null; effectiveStatus: string | null }>();
  if (adIds.length) {
    const { data: ads } = await admin
      .from("ads")
      .select("fb_ad_id, name, creative_thumb_url, creative_image_url, created_at, status, effective_status")
      .eq("tenant_id", tenantId)
      .in("fb_ad_id", adIds);
    for (const a of ads ?? []) adInfo.set(a.fb_ad_id, { name: a.name, thumb: a.creative_thumb_url, image: a.creative_image_url, createdAt: a.created_at, status: a.status, effectiveStatus: a.effective_status });
  }

  // Ad-set names (the "angle" under the folder-launch model) for the ad's secondary line.
  const adsetIds = [...new Set(rows.map((r) => r.fb_adset_id).filter(Boolean) as string[])];
  const adsetName = new Map<string, string>();
  if (adsetIds.length) {
    const { data: adsets } = await admin.from("adsets").select("fb_adset_id, name").eq("tenant_id", tenantId).in("fb_adset_id", adsetIds);
    for (const a of adsets ?? []) if (a.name) adsetName.set(a.fb_adset_id, a.name);
  }

  return rows.map((r) => {
    const info = r.fb_ad_id ? adInfo.get(r.fb_ad_id) : undefined;
    // An operator-corrected name (explicit first/last split) beats GHL's stored name, which beats
    // what the lead typed in the Meta form.
    const overrideName = [r.first_name_override, r.last_name_override].filter(Boolean).join(" ");
    return {
      id: r.id,
      metaLeadId: r.meta_lead_id,
      createdTime: r.created_time,
      fullName: overrideName || (r.ghl_name ? titleCase(r.ghl_name) : r.full_name),
      nameOriginal: r.full_name,
      firstNameOverride: r.first_name_override,
      lastNameOverride: r.last_name_override,
      email: r.email_override ?? r.email,
      emailOriginal: r.email,
      website: r.website_override ?? companyDomainFromEmail(r.email_override ?? r.email),
      websiteInferred: companyDomainFromEmail(r.email_override ?? r.email),
      company: (r as any).company ?? null,
      phone: r.phone_override ?? r.phone,
      phoneOriginal: r.phone,
      additionalEmail: r.additional_email,
      additionalPhone: r.additional_phone,
      adId: r.fb_ad_id,
      adName: r.ad_name ?? info?.name ?? null,
      adThumbUrl: info?.thumb ?? null,
      adImageUrl: info?.image ?? null,
      adSetName: r.fb_adset_id ? adsetName.get(r.fb_adset_id) ?? null : null,
      adCreatedAt: info?.createdAt ?? null,
      adStatus: info?.status ?? null,
      adEffectiveStatus: info?.effectiveStatus ?? null,
      channel: (r as any).channel ?? null,
      campaignId: r.fb_campaign_id,
      qualification: r.qualification as Qualification,
      callState: (r.call_state as CallState) ?? "none",
      callAttempts: r.call_attempts ?? 0,
      appointmentAt: r.appointment_at ?? null,
      appointmentEndAt: r.appointment_end_at ?? null,
      appointmentStatus: r.appointment_status ?? null,
      appointmentTitle: r.appointment_title ?? null,
      appointmentLink: r.appointment_link ?? null,
      taskId: r.ghl_task_id ?? null,
      taskTitle: r.task_title ?? null,
      taskDueAt: r.task_due_at ?? null,
      taskCount: r.task_count ?? 0,
      notesCount: r.notes_count ?? 0,
      notesCache: Array.isArray((r as any).notes_cache) ? (r as any).notes_cache : null,
      ghlOpportunityId: (r as any).ghl_opportunity_id ?? null,
      opportunityValue: (r as any).opportunity_value == null ? null : Number((r as any).opportunity_value),
      opportunityStatus: (r as any).opportunity_status ?? null,
      lastCallAttemptAt: r.last_call_attempt_at ?? null,
      matched: !!r.ghl_contact_id,
      ghlContactId: r.ghl_contact_id ?? null,
      ghlContactUrl: ghlUrl(r.ghl_contact_id),
      answers: (r.answers ?? []) as LeadAnswer[],
      source: (r.source as LeadView["source"]) ?? "instant_form",
      stage: (r.stage as "started" | "completed" | null) ?? null,
      auditUrl: (r as any).audit_url ?? null,
      needsRebook: rebook.has(r.id),
      awaitingOutcome: awaiting.has(r.id),
      latestAttendance: latestMeeting.get(r.id)?.attendance ?? null,
      latestOutcome: latestMeeting.get(r.id)?.outcome ?? null,
      latestConfirmedAt: latestMeeting.get(r.id)?.confirmedAt ?? null,
      apptAttendance: ((r as any).ghl_appointment_id && apptVerdict.get(r.id)?.get(String((r as any).ghl_appointment_id))?.attendance) ?? null,
      apptConfirmedAt: ((r as any).ghl_appointment_id && apptVerdict.get(r.id)?.get(String((r as any).ghl_appointment_id))?.confirmedAt) ?? null,
      meetingCount: meetingCount.get(r.id) ?? 0,
      duplicateCount: dupeOf.get(r.id) ?? 0,
    } satisfies LeadView;
  });
}
