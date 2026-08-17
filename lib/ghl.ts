/**
 * GoHighLevel (LeadConnector v2) read client — used only to learn each lead's qualified/unqualified
 * status. We pull the location's contacts once per sync, index them by phone, and read their tags.
 * GHL is NOT our source for "which ad" (it doesn't reliably store that) — Meta is. See lib/sync/leads.ts.
 */
import { withGhlRetry, GHL_TIMEOUT_MS } from "./ghl-retry";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

/**
 * EVERY GoHighLevel request in this file goes through here — never bare `fetch`.
 *
 * These reads were previously unbounded while the write client (lib/ghl-write.ts) had always been capped,
 * so a single hung connection could hold the serverless function open to its platform limit. That is the
 * failure the `timeout of ...ms exceeded` Slack alerts were reporting: the function got killed before the
 * route could answer, so its own transient-suppression never ran.
 *
 * A trip throws DOMException("TimeoutError"), which isTransientGhlError treats as transient — so calls
 * wrapped in withGhlRetry (all of them here) retry it, and a genuinely dead endpoint surfaces as a normal
 * error the caller already knows how to handle by keeping its stored value.
 *
 * The wrapper exists rather than nine inline `signal:` properties so a new read cannot silently be added
 * unbounded: there is one place to get this right.
 */
function ghlRead(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(GHL_TIMEOUT_MS) });
}

/**
 * Tags (lower-cased) that mark a lead's QUALIFICATION — the pre-meet filter: did this ad lead make it
 * to a Google Meet? `qualified` wins if a contact has both.
 *
 * Deliberately NOT here: `disqualified` (the ONE canonical post-meet tag — the legacy `dq` registry
 * entry was deleted 2026-07-18). In Miguel's process it is a SEPARATE, post-meet stage (went to the
 * Meet, then ruled out — no budget etc.). It must never read as "unqualified" and the dashboard must
 * never strip it — it belongs to the team's post-meet workflow inside GHL.
 */
const QUALIFIED_TAGS = new Set(["qualified"]);
const UNQUALIFIED_TAGS = new Set(["unqualified"]);

export type Qualification = "qualified" | "unqualified" | "pending";

/** Tags (lower-cased) that mark whether we've called a lead. `contacted` wins if a contact has both. */
const CONTACTED_TAGS = new Set(["contacted"]);
const NO_ANSWER_TAGS = new Set(["no response", "no-response", "no answer"]);
const INVALID_PHONE_TAGS = new Set(["invalid number", "invalid-number", "invalid phone", "wrong number"]);
const FOLLOW_UP_TAGS = new Set(["follow-up", "follow up", "followup"]);
// A booked Google Meet — the strongest positive call outcome. Auto-applied by the appointment mirror
// when GHL shows a booking (see lib/sync/leads.ts); also selectable by hand in the Call dropdown.
const MEETING_BOOKED_TAGS = new Set(["meeting booked", "meeting-booked", "meeting scheduled", "call booked", "booked"]);

export type CallState = "none" | "contacted" | "no_answer" | "invalid_phone" | "follow_up" | "meeting_booked";

/**
 * Canonical GHL tag names written by the Leads tab, plus the full set to strip when leaving a state.
 * A state flip must REMOVE the whole opposite set (not just the canonical) so a manually-applied variant
 * (e.g. "dq") can't linger and freeze the derived value — the reader gives `qualified`/`contacted`
 * precedence, so a stray opposite tag would otherwise win forever.
 */
export const QUAL_WRITE = {
  // Never remove `disqualified` here — that's the team's post-meet stage, not ours to touch.
  qualified: { add: "qualified" as string | null, removeAll: ["unqualified"] },
  unqualified: { add: "unqualified" as string | null, removeAll: ["qualified"] },
  pending: { add: null as string | null, removeAll: ["qualified", "unqualified"] },
} as const;

const NO_ANSWER_VARIANTS = ["no response", "no-response", "no answer"];
const INVALID_PHONE_VARIANTS = ["invalid number", "invalid-number", "invalid phone", "wrong number"];
const FOLLOW_UP_VARIANTS = ["follow-up", "follow up", "followup"];
const MEETING_BOOKED_VARIANTS = ["meeting booked", "meeting-booked", "meeting scheduled", "call booked", "booked"];
export const CALL_WRITE = {
  contacted: { add: "contacted" as string | null, removeAll: [...NO_ANSWER_VARIANTS, ...INVALID_PHONE_VARIANTS, ...FOLLOW_UP_VARIANTS, ...MEETING_BOOKED_VARIANTS] },
  no_answer: { add: "no response" as string | null, removeAll: ["contacted", ...INVALID_PHONE_VARIANTS, ...FOLLOW_UP_VARIANTS, ...MEETING_BOOKED_VARIANTS] },
  invalid_phone: { add: "invalid number" as string | null, removeAll: ["contacted", ...NO_ANSWER_VARIANTS, ...FOLLOW_UP_VARIANTS, ...MEETING_BOOKED_VARIANTS] },
  follow_up: { add: "follow-up" as string | null, removeAll: ["contacted", ...NO_ANSWER_VARIANTS, ...INVALID_PHONE_VARIANTS, ...MEETING_BOOKED_VARIANTS] },
  meeting_booked: { add: "meeting booked" as string | null, removeAll: ["contacted", ...NO_ANSWER_VARIANTS, ...INVALID_PHONE_VARIANTS, ...FOLLOW_UP_VARIANTS] },
  none: { add: null as string | null, removeAll: ["contacted", ...NO_ANSWER_VARIANTS, ...INVALID_PHONE_VARIANTS, ...FOLLOW_UP_VARIANTS, ...MEETING_BOOKED_VARIANTS] },
} as const;

export interface GhlContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  /** GHL `dateAdded` — when the contact entered the CRM. A cold-call lead's "Submitted" date. */
  dateAdded: string | null;
  /** GHL's native company field — read so the sync's extractor mirror never clobbers a CRM-side value. */
  companyName: string | null;
  /** Custom-field values keyed by field id — the "Lead Source" dropdown (source classification) reads
   *  from here. Values arrive as strings/arrays depending on field type. */
  customFields: Record<string, unknown>;
}

function ghlCfg(): { key: string; location: string } | null {
  const key = process.env.GHL_API_KEY;
  const location = process.env.GHL_LOCATION_ID;
  if (!key || !location) return null;
  return { key, location };
}

export function ghlConfigured(): boolean {
  return ghlCfg() !== null;
}

/**
 * Permanently delete a contact in GoHighLevel. Idempotent: a contact that is already gone
 * (GHL answers a missing contact with HTTP 400 "Contact not found") counts as success. Transient
 * gateway blips (429/502/503/504) retry; a real failure returns {ok:false, status} instead of throwing,
 * so a GHL hiccup never blocks the dashboard-side lead deletion. {ok:false, status:0} if GHL isn't
 * configured or no id was given.
 */
export async function deleteGhlContact(contactId: string | null | undefined): Promise<{ ok: boolean; status: number }> {
  const cfg = ghlCfg();
  if (!cfg || !contactId) return { ok: false, status: 0 };
  return withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" },
    });
    // 200 = deleted now; 400/404 = already gone. Both are terminal success.
    if (res.ok || res.status === 400 || res.status === 404) return { ok: true, status: res.status };
    // Throw so withGhlRetry retries transient gateway statuses; a hard 4xx/5xx exhausts retries and is caught below.
    const text = await res.text().catch(() => "");
    throw new Error(`GHL contacts/delete ${res.status}: ${text.slice(0, 200)}`);
  }).catch((e) => {
    const status = Number(String(e instanceof Error ? e.message : e).match(/\s(\d{3}):\s/)?.[1] ?? 0);
    return { ok: false, status };
  });
}

/** Digits-only and last-9-digits keys for tolerant phone matching across Meta (+351…) and GHL. */
export function phoneKeys(raw: string | null | undefined): string[] {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 6) return [];
  const last9 = digits.slice(-9);
  return last9 && last9 !== digits ? [digits, last9] : [digits];
}

/** Normalized email key (lowercase, trimmed) for matching across Meta and GHL, or null when not an email. */
export function emailKey(raw: string | null | undefined): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.includes("@") && e.length <= 254 ? e : null;
}

/** Resolve a contact's tags to a qualification verdict. `qualified` takes precedence over a stale DQ. */
export function qualificationFromTags(tags: string[]): Qualification {
  const lower = tags.map((t) => t.toLowerCase().trim());
  if (lower.some((t) => QUALIFIED_TAGS.has(t))) return "qualified";
  if (lower.some((t) => UNQUALIFIED_TAGS.has(t))) return "unqualified";
  return "pending";
}

/** Resolve a contact's tags to a call state. `follow-up` is the operator's latest intent, so it wins;
 *  then `contacted` (we reached them); an invalid number beats `no response` (ring-outs are
 *  meaningless on a bad number). */
export function callStateFromTags(tags: string[]): CallState {
  const lower = tags.map((t) => t.toLowerCase().trim());
  // A booked meeting is the strongest signal — it outranks every "trying to reach them" state.
  if (lower.some((t) => MEETING_BOOKED_TAGS.has(t))) return "meeting_booked";
  if (lower.some((t) => FOLLOW_UP_TAGS.has(t))) return "follow_up";
  if (lower.some((t) => CONTACTED_TAGS.has(t))) return "contacted";
  if (lower.some((t) => INVALID_PHONE_TAGS.has(t))) return "invalid_phone";
  if (lower.some((t) => NO_ANSWER_TAGS.has(t))) return "no_answer";
  return "none";
}

/** Pull every contact in the configured location (paginated). Returns [] if GHL isn't configured. */
export async function fetchAllGhlContacts(): Promise<GhlContact[]> {
  const cfg = ghlCfg();
  if (!cfg) return [];
  const out: GhlContact[] = [];
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 200; // safety: caps at 20k contacts
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json: any = await withGhlRetry(async () => {
      const res = await ghlRead(`${GHL_BASE}/contacts/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.key}`,
          Version: GHL_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ locationId: cfg.location, page, pageLimit: PAGE_LIMIT }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GHL contacts/search ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    });
    const contacts: any[] = Array.isArray(json?.contacts) ? json.contacts : [];
    for (const c of contacts) {
      const name =
        (c.contactName && String(c.contactName).trim()) ||
        [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
        (c.name && String(c.name).trim()) ||
        null;
      out.push({
        id: String(c.id),
        name,
        phone: c.phone ?? null,
        email: c.email ?? null,
        tags: Array.isArray(c.tags) ? c.tags : [],
        dateAdded: c.dateAdded ? String(c.dateAdded) : null,
        companyName: c.companyName ? String(c.companyName) : null,
        customFields: Object.fromEntries((Array.isArray(c.customFields) ? c.customFields : []).map((f: any) => [String(f.id), f.value])),
      });
    }
    const total: number | undefined = json?.total;
    if (contacts.length < PAGE_LIMIT) break;
    if (typeof total === "number" && out.length >= total) break;
  }
  return out;
}

export interface GhlAppointment {
  id: string;
  startIso: string; // ISO with offset (from the by-id endpoint)
  endIso: string | null;
  status: string | null; // GHL's appointmentStatus verbatim: confirmed | showed | noshow | new …
  title: string | null;
  link: string | null; // the booking's meeting URL (Google Meet) when its address is one
}

const DEAD_APPT_STATUS = new Set(["cancelled", "invalid"]);

/** Read one appointment by id → GhlAppointment, or null when it's truly gone/cancelled/deleted.
 *  Throws on transport errors (so callers can keep stale data); a 404/400-not-found returns null. */
export async function fetchAppointmentById(appointmentId: string): Promise<GhlAppointment | null> {
  const cfg = ghlCfg();
  if (!cfg) return null;
  const headers = { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" };
  const detail: any = await withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, { headers });
    // 404 is this endpoint's ONLY true "gone" (live-probed: invalid/unknown ids all answer 404
    // "Please provide a valid calendar event ID"). A 400 here is a malformed request or one of GHL's
    // mislabeled internal failures — those must THROW so callers keep stale data instead of clearing
    // a live booking (this null is the gate that blanks stored mirrors).
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GHL appointments/get ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
  const a = detail?.appointment ?? {};
  if (!a.startTime || a.deleted === true || DEAD_APPT_STATUS.has(String(a.appointmentStatus ?? "").toLowerCase())) return null;
  const address = typeof a.address === "string" && /^https?:\/\//i.test(a.address.trim()) ? a.address.trim() : null;
  return {
    id: String(a.id ?? appointmentId),
    startIso: String(a.startTime),
    endIso: a.endTime ? String(a.endTime) : null,
    status: a.appointmentStatus ? String(a.appointmentStatus) : null,
    title: a.title ? String(a.title) : null,
    link: address,
  };
}

/**
 * All live appointments across every calendar in the location, indexed by contactId. This is the
 * PRIMARY appointment read for the sync: the per-contact list endpoint intermittently returns [] for
 * contacts whose bookings still exist (live-caught 2026-07-19, wiped every mirrored booking), while
 * the per-calendar events endpoint is the one GHL's own UI runs on. Window: 90d back / 180d forward
 * (past bookings older than that stop mattering for the CRM). Also cheaper: one call per calendar
 * instead of one per contact. Throws on failure so the caller can fall back / keep stale data.
 */
export interface SweepEvent {
  id: string;
  startTime: string;
  endTime: string | null;
  status: string | null;
  title: string | null;
  link: string | null;
  calendarId: string | null;
  /** Cancelled/deleted. Excluded from "which booking is current", but KEPT for the call history —
   *  a cancelled meeting is a fact about the lead, not an absence of one. */
  dead: boolean;
}
export async function fetchAppointmentsByContact(): Promise<Map<string, SweepEvent[]>> {
  const out = new Map<string, SweepEvent[]>();
  const cfg = ghlCfg();
  if (!cfg) return out;
  const headers = { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" };
  const cals: any = await withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/calendars/?locationId=${encodeURIComponent(cfg.location)}`, { headers });
    if (!res.ok) throw new Error(`GHL calendars/list ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
  const calendars: any[] = Array.isArray(cals?.calendars) ? cals.calendars : [];
  const startMs = Date.now() - 90 * 86_400_000;
  const endMs = Date.now() + 180 * 86_400_000;
  let failed = 0;
  for (const cal of calendars) {
    if (!cal?.id) continue;
    try {
      const j: any = await withGhlRetry(async () => {
        const res = await ghlRead(
          `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(cfg.location)}&calendarId=${encodeURIComponent(String(cal.id))}&startTime=${startMs}&endTime=${endMs}`,
          { headers }
        );
        if (!res.ok) throw new Error(`GHL calendars/events ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
        return res.json();
      });
      for (const e of (Array.isArray(j?.events) ? j.events : []) as any[]) {
        if (!e?.id || !e?.contactId || !e?.startTime) continue;
        // Dead bookings are MARKED, not dropped: the meeting history needs them (a cancelled call is
        // part of the story), while pickRelevantAppointment skips them so a cancelled booking can
        // never be mistaken for the lead's current one.
        const dead = e.deleted === true || DEAD_APPT_STATUS.has(String(e.appointmentStatus ?? "").toLowerCase());
        const address = typeof e.address === "string" && /^https?:\/\//i.test(e.address.trim()) ? e.address.trim() : null;
        const key = String(e.contactId);
        const item: SweepEvent = {
          id: String(e.id),
          startTime: String(e.startTime),
          endTime: e.endTime ? String(e.endTime) : null,
          status: e.appointmentStatus ? String(e.appointmentStatus) : null,
          title: e.title ? String(e.title) : null,
          link: address,
          calendarId: e.calendarId ? String(e.calendarId) : null,
          dead,
        };
        const arr = out.get(key);
        if (arr) arr.push(item);
        else out.set(key, [item]);
      }
    } catch (e) {
      // One broken calendar must not sink the sweep: its stored bookings survive via the caller's
      // by-id verify; only when EVERY calendar fails is the sweep useless enough to throw.
      failed++;
      console.warn(`calendar sweep: calendar ${cal.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (calendars.length > 0 && failed === calendars.length) {
    throw new Error("GHL calendar sweep: every calendar read failed");
  }
  return out;
}

/**
 * Pick the relevant booking from a contact's candidates: next upcoming, else most recent past.
 * Handles both time shapes GHL emits — ISO with offset (parseable) and naive location-local strings
 * (compared lexicographically against "now" rendered in Europe/Lisbon; single-location app).
 */
export function pickRelevantAppointment(all: { id: string; startTime: string; dead?: boolean }[]): string | null {
  const events = all.filter((e) => !e.dead); // a cancelled booking is never the "current" one
  if (!events.length) return null;
  const isoish = (s: string) => /\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s);
  const allIso = events.every((e) => isoish(e.startTime));
  const nowKey = allIso ? new Date().toISOString() : new Date().toLocaleString("sv-SE", { timeZone: "Europe/Lisbon" });
  const cmp = (a: string, b: string) => (allIso ? Date.parse(a) - Date.parse(b) : a.localeCompare(b));
  const isUpcoming = (s: string) => (allIso ? Date.parse(s) >= Date.now() : s >= nowKey);
  const upcoming = events.filter((e) => isUpcoming(e.startTime)).sort((a, b) => cmp(a.startTime, b.startTime));
  const past = events.filter((e) => !isUpcoming(e.startTime)).sort((a, b) => cmp(b.startTime, a.startTime));
  return (upcoming[0] ?? past[0])?.id ?? null;
}

/**
 * The contact's relevant calendar appointment: the next upcoming booking, else the most recent past
 * one. Cancelled/deleted bookings never count. Two calls on purpose: the per-contact list endpoint
 * returns NAIVE local-time strings (location timezone, no offset), so it is only used to CHOOSE the
 * appointment — the by-id endpoint then supplies exact ISO times with offset, keeping us out of
 * timezone math. Throws on read failure so callers can keep stale data rather than blank the booking.
 *
 * `knownId` guard (live-caught 2026-07-19): GHL's per-contact list endpoint INTERMITTENTLY returns []
 * while the appointment still exists (Fernando's confirmed call vanished from the list; the by-id read
 * still returned it — that wiped all mirrored bookings for a day). An empty list is therefore NEVER
 * trusted to clear a stored booking: when the caller knows the currently-stored appointment id, it is
 * re-verified by id, and only a true gone/cancelled answer clears it.
 */
export async function fetchContactAppointment(contactId: string, knownId?: string | null): Promise<GhlAppointment | null> {
  const cfg = ghlCfg();
  if (!cfg) return null;
  const headers = { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" };
  const list: any = await withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/appointments`, { headers });
    if (!res.ok) throw new Error(`GHL contact/appointments ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
  const events: any[] = (Array.isArray(list?.events) ? list.events : []).filter(
    (e: any) => e?.id && e?.startTime && e?.deleted !== true && !DEAD_APPT_STATUS.has(String(e.appointmentStatus ?? "").toLowerCase())
  );
  if (!events.length) return knownId ? fetchAppointmentById(knownId) : null;
  // List startTimes are "YYYY-MM-DD HH:MM:SS" in the location's timezone — lexicographic order IS time
  // order. "Now" formatted the same way splits upcoming from past. Single-location app on Europe/Lisbon.
  const nowLocal = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Lisbon" });
  const upcoming = events.filter((e) => String(e.startTime) >= nowLocal).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const past = events.filter((e) => String(e.startTime) < nowLocal).sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  const chosen = upcoming[0] ?? past[0];
  const resolved = await fetchAppointmentById(String(chosen.id));
  // The chosen candidate can die between the list read and the by-id read (just-cancelled). A stored
  // DIFFERENT booking must be re-verified before the caller clears it on our null (review 2026-07-20).
  if (!resolved && knownId && knownId !== String(chosen.id)) return fetchAppointmentById(knownId);
  return resolved;
}

export interface GhlTask {
  id: string;
  title: string;
  dueIso: string | null; // GHL normalizes dueDate to UTC ISO
  openCount: number; // total OPEN tasks on the contact (this is the earliest of them)
}

/**
 * The contact's next OPEN task (earliest due date; undated tasks sort last). Completed tasks never
 * count — a contact with only those returns null, which clears the mirrored columns. Throws on read
 * failure so callers can keep stale data rather than blank the task.
 */
export async function fetchContactOpenTask(contactId: string): Promise<GhlTask | null> {
  const cfg = ghlCfg();
  if (!cfg) return null;
  const json: any = await withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tasks`, {
      headers: { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GHL contact/tasks ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
  const open: any[] = (Array.isArray(json?.tasks) ? json.tasks : []).filter((t: any) => t?.id && t?.completed !== true);
  if (!open.length) return null;
  open.sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")));
  const t = open[0];
  return { id: String(t.id), title: String(t.title ?? "Task"), dueIso: t.dueDate ? String(t.dueDate) : null, openCount: open.length };
}

/** EVERY open task on a contact (fetchContactOpenTask returns only the earliest + a count) — needed
 *  when automation must find a specific task by title, e.g. the auto-created "call to rebook" one. */
export async function listOpenContactTasks(contactId: string): Promise<{ id: string; title: string; dueIso: string | null }[]> {
  const cfg = ghlCfg();
  if (!cfg) return [];
  const json: any = await withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tasks`, {
      headers: { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GHL contact/tasks ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
  return (Array.isArray(json?.tasks) ? json.tasks : [])
    .filter((t: any) => t?.id && t?.completed !== true)
    .map((t: any) => ({ id: String(t.id), title: String(t.title ?? "Task"), dueIso: t.dueDate ? String(t.dueDate) : null }));
}

/** A free-text note on a GHL contact — the call-log / reference entries shown in the Leads panel. */
export interface GhlNote {
  id: string;
  body: string;
  createdAt: string | null; // ISO (GHL `dateAdded`)
}

/** Every note on a contact, newest first. GHL native Notes are the source of truth (they also show in GHL). */
export async function fetchContactNotes(contactId: string): Promise<GhlNote[]> {
  const cfg = ghlCfg();
  if (!cfg) return [];
  const json: any = await withGhlRetry(async () => {
    const res = await ghlRead(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/notes`, {
      headers: { Authorization: `Bearer ${cfg.key}`, Version: GHL_VERSION, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GHL contact/notes ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  });
  const notes: any[] = Array.isArray(json?.notes) ? json.notes : [];
  return notes
    .filter((n) => n?.id)
    .map((n) => ({ id: String(n.id), body: String(n.body ?? n.bodyText ?? ""), createdAt: n.dateAdded ? String(n.dateAdded) : null }))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))); // newest first
}

export interface GhlContactIndex {
  byPhone: Map<string, GhlContact>;
  byEmail: Map<string, GhlContact>;
  count: number;
}

/** Index contacts by every phone key AND by email, so a Meta lead can find its GHL contact in O(1). */
export function indexContacts(contacts: GhlContact[]): GhlContactIndex {
  const byPhone = new Map<string, GhlContact>();
  const byEmail = new Map<string, GhlContact>();
  for (const c of contacts) {
    for (const k of phoneKeys(c.phone)) {
      if (!byPhone.has(k)) byPhone.set(k, c);
    }
    const ek = emailKey(c.email);
    if (ek && !byEmail.has(ek)) byEmail.set(ek, c);
  }
  return { byPhone, byEmail, count: contacts.length };
}

/**
 * Find the GHL contact for a Meta lead. Phone is tried FIRST (full-digits then last-9) — the proven path,
 * so existing matches never change — then email as a FALLBACK, which only links leads the phone couldn't.
 * Returns which key matched (for the sync's health reporting), or null.
 */
export function matchContact(
  index: GhlContactIndex,
  lead: { phone?: string | null; email?: string | null }
): { contact: GhlContact; via: "phone" | "email" } | null {
  for (const k of phoneKeys(lead.phone)) {
    const hit = index.byPhone.get(k);
    if (hit) return { contact: hit, via: "phone" };
  }
  const ek = emailKey(lead.email);
  if (ek) {
    const hit = index.byEmail.get(ek);
    if (hit) return { contact: hit, via: "email" };
  }
  return null;
}
