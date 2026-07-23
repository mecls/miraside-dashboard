/** Shared lead types + normalization of Meta's raw field_data into a clean, displayable shape. */
import type { MetaLeadRaw } from "./meta-ads";
import type { Qualification, CallState } from "./ghl";

export type { Qualification, CallState };

export interface LeadAnswer {
  key: string;
  label: string;
  value: string;
  shortLabel?: string; // short CRM-style label for the Slack notification (AI-generated, cached)
}

export interface NormalizedLead {
  metaLeadId: string;
  createdTime: string | null; // ISO
  formId: string | null;
  fbAdId: string | null;
  fbAdsetId: string | null;
  fbCampaignId: string | null;
  adName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  websiteOverride?: string | null; // operator-set website (Leads tab) — pushes must prefer it over email inference
  answers: LeadAnswer[]; // the custom qualifying questions (name/email/phone excluded)
}

const STANDARD_FIELDS = new Set(["full_name", "first_name", "last_name", "email", "phone_number"]);
const FIELD_LABELS: Record<string, string> = {
  full_name: "Name",
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  phone_number: "Phone",
};

/** Meta's custom-question keys are slugified versions of the question — "_"→" " recovers a readable label. */
function prettifyKey(k: string): string {
  const s = k.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}
function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? prettifyKey(key);
}

function firstValue(values: string[] | undefined): string {
  return Array.isArray(values) && values.length ? String(values[0]) : "";
}

/** Turn a raw Meta lead into our normalized shape: contact fields surfaced, custom answers collected. */
export function normalizeMetaLead(raw: MetaLeadRaw): NormalizedLead {
  const map = new Map<string, string>();
  const answers: LeadAnswer[] = [];
  for (const f of raw.field_data ?? []) {
    const key = String(f.name);
    const value = firstValue(f.values);
    map.set(key, value);
    if (!STANDARD_FIELDS.has(key) && value) {
      answers.push({ key, label: labelFor(key), value });
    }
  }
  const fullName =
    map.get("full_name") ||
    [map.get("first_name"), map.get("last_name")].filter(Boolean).join(" ").trim() ||
    null;

  return {
    metaLeadId: String(raw.id),
    createdTime: raw.created_time ? new Date(raw.created_time).toISOString() : null,
    formId: raw.form_id ?? null,
    fbAdId: raw.ad_id ?? null,
    fbAdsetId: raw.adset_id ?? null,
    fbCampaignId: raw.campaign_id ?? null,
    adName: raw.ad_name ?? null,
    fullName,
    email: map.get("email") || null,
    phone: map.get("phone_number") || null,
    answers,
  };
}

/** Row shape returned to the Leads UI (DB row joined with the ad's thumbnail). */
export interface LeadView {
  id: string;
  metaLeadId: string;
  createdTime: string | null;
  fullName: string | null; // effective: operator-corrected name → GHL's name → Meta's form name
  nameOriginal: string | null; // what the lead typed in the form — the revert target for name edits
  firstNameOverride: string | null; // operator's explicit first/last split (null when name untouched)
  lastNameOverride: string | null;
  email: string | null; // effective email: operator correction (email_override) when set, else Meta's
  emailOriginal: string | null; // the email Meta actually delivered — the revert target for email edits
  website: string | null; // effective: operator-set (website_override) → inferred from a professional email domain
  websiteInferred: string | null; // the inference alone — the revert target when clearing an override
  /** Company name extracted from the lead's website by the sync (og:site_name / JSON-LD / title). */
  company: string | null;
  phone: string | null; // effective phone: operator correction (phone_override) when set, else Meta's
  phoneOriginal: string | null; // the number Meta actually delivered — kept searchable after a correction
  additionalEmail: string | null; // operator-entered; mirrored to the GHL "Additional Email" custom field
  additionalPhone: string | null; // operator-entered; mirrored to the GHL "Additional Phone" custom field
  adId: string | null; // fb ad id
  adName: string | null;
  adThumbUrl: string | null;
  adImageUrl: string | null; // full-resolution creative, for the click-to-enlarge view
  adSetName: string | null; // the ad set / angle name (secondary identity under an ambiguous ad name)
  adCreatedAt: string | null;
  /** The ad's OWN configured on/off switch ("ACTIVE"/"PAUSED"). A paused ad set leaves this ACTIVE. */
  adStatus: string | null;
  /** Meta's effective_status — REAL delivery (honours a paused ad set/campaign, disapproval, billing).
   *  Null until the next Facebook sync fills it. The scoreboard dot's source of truth. */
  adEffectiveStatus: string | null;
  channel: string | null; // attribution channel — "Paid Ads" (from an ad) vs "Direct" (just hit the URL) etc.
  campaignId: string | null;
  qualification: Qualification;
  callState: CallState;
  callAttempts: number; // times we've dialed (auto on outcome flips + manual "+1"); mirrored to GHL "Call Attempts"
  lastCallAttemptAt: string | null; // when we last dialed — drives call-recency display + retry queue order
  appointmentAt: string | null; // the lead's GHL calendar booking (next upcoming, else latest past) — mirrored each sync
  appointmentEndAt: string | null;
  appointmentStatus: string | null; // GHL's appointmentStatus verbatim: confirmed | showed | noshow | new …
  appointmentTitle: string | null;
  appointmentLink: string | null; // meeting URL (Google Meet) when the booking carries one
  taskId: string | null; // the lead's next OPEN GHL task (the pending to-do, e.g. "Call again") — mirrored each sync
  taskTitle: string | null;
  taskDueAt: string | null;
  taskCount: number; // total open GHL tasks on the contact (taskId is the earliest); drives "+N more"
  notesCount: number;
  /** Cached copy of the contact's GHL notes (newest first) — instant render for the notes popup while
   *  the live GHL fetch reconciles. Null = never cached (fall back to the loading state). */
  notesCache: { id: string; body: string; createdAt: string | null }[] | null;
  /** The lead's GHL opportunity (created by the booking workflow, discovered+linked by sync). GHL is
   *  the source of truth; the dashboard writes value/status back through it. */
  ghlOpportunityId: string | null;
  opportunityValue: number | null; // deal value in EUR (mirrors GHL monetaryValue)
  opportunityStatus: string | null; // open | won | lost | abandoned
  /** A booked call they missed (no-show/cancelled) with no outcome recorded since — owes a rebook. */
  needsRebook: boolean;
  /** A booked call whose time has passed but which GHL still reports as scheduled — nobody has ruled
   *  whether they showed. Keeps the lead on the worklist until attendance is recorded. */
  awaitingOutcome: boolean;
  /** The most recent meeting's verdict — drives the WhatsApp template choice. Null with no meetings. */
  latestAttendance: "scheduled" | "showed" | "no_show" | "cancelled" | null;
  latestOutcome: "follow_up_booked" | "proposal_sent" | "won" | "disqualified" | null;
  /** When the latest meeting's day-before confirmation was ticked (null = not yet confirmed). */
  latestConfirmedAt: string | null;
  /** Verdict of the SPECIFIC meeting the appointment mirror points at (leads.ghl_appointment_id) —
   *  the Meeting chip's referent. Latest-by-time can name a DIFFERENT (e.g. cancelled) meeting than
   *  the mirrored live one; the chip must dress the meeting it actually displays. Null = no match
   *  (manual meeting, or history row not yet created) → fall back to latestAttendance. */
  apptAttendance: "scheduled" | "showed" | "no_show" | "cancelled" | null;
  apptConfirmedAt: string | null;
  /** How many calls have ever been booked with this lead. */
  meetingCount: number;
  /** >0 when this person appears more than once (same phone or email) — 2 means one duplicate. */
  duplicateCount: number; // GHL notes on the contact; drives the row's note chip (reconciled when notes are viewed)
  matched: boolean;
  ghlContactUrl: string | null;
  answers: LeadAnswer[];
  source: "instant_form" | "website" | "cold_call" | "cold_email" | "organic" | "linkedin_dm" | "referral";
  stage: "started" | "completed" | null; // website audit progress (null for instant forms)
  auditUrl: string | null; // the generated ROI audit's public URL (instant-form leads, via audit-intake)
}
