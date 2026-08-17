/**
 * Shared GoHighLevel write primitives: upsert a contact (by phone/email), add tags, and ensure a
 * contact-level single-line custom field exists in the "ADS" folder. Used by both the instant-form
 * push (lib/ghl-push.ts) and the website-audit endpoint. Needs GHL_API_KEY + GHL_LOCATION_ID
 * (+ GHL_ADS_FOLDER_ID for where new fields land).
 */
import { withGhlRetry, GHL_TIMEOUT_MS } from "./ghl-retry";
import { fieldFingerprint } from "./fingerprint";
import { companyDomainFromEmail } from "./email-domain";
import { createAdminClient } from "./supabase/admin";
import { getPrimaryTenantId } from "./tenant";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
export const AD_FIELD_NAME = "Anúncio";
// NOTE: "Lead Source" is the SINGLE_OPTIONS dropdown now (see LEAD_SOURCE_FIELD below) — the old TEXT
// field of the same name was deleted 2026-07-23 on Miguel's instruction.
export const CONVERSION_SOURCE_FIELD = "Conversion Source";
// GHL's native additionalEmails/additionalPhones are read-only via the API (highlevel-api-docs #262),
// so operator-entered secondary contact info lives in these custom fields instead.
export const ADDITIONAL_EMAIL_FIELD = "Additional Email";
export const ADDITIONAL_PHONE_FIELD = "Additional Phone";
// Mirror of leads.call_attempts (dashboard = source of truth) so the CRM shows how many times we dialed.
export const CALL_ATTEMPTS_FIELD = "Call Attempts";
// THE source dropdown (SINGLE_OPTIONS, "Lead Source", id CvfKtDgldrGobSuFBE4D — Miguel: one system for
// source, a dropdown, not tags). Operators set it on imported contacts; automation fills it write-once
// for ad/website leads. (GHL reserves the bare name "Source" for its native contact.source.)
export const LEAD_SOURCE_FIELD = "Lead Source";
export const LEAD_SOURCE_OPTIONS = ["Paid Ads", "Cold Call", "Cold Email", "LinkedIn DMs", "Organic", "Referral"] as const;

/** Closest dropdown option for an attribution channel — what automation fills the dropdown with. */
export function originOptionForChannel(channel: string | null | undefined): string {
  switch (channel) {
    case "Paid Ads":
      return "Paid Ads";
    case "Referral":
      return "Referral";
    case "Cold Email":
      return "Cold Email";
    case "LinkedIn":
      return "LinkedIn DMs";
    default:
      return "Organic"; // YouTube / Instagram / X / Website / Direct / Other — found us on their own
  }
}

export function ghlConfig() {
  const key = process.env.GHL_API_KEY;
  const location = process.env.GHL_LOCATION_ID;
  const folder = process.env.GHL_ADS_FOLDER_ID;
  if (!key || !location) return null;
  return { key, location, folder };
}

/** Safety net for legacy slugged answers (new leads arrive resolved to the form's real option text
 *  via resolveMetaAnswers): numeric ranges get their separator back; underscores become spaces. */
export function prettyAnswer(v: string): string {
  if (!v || !v.includes("_")) return v;
  const range = v.match(/^(\d+)_(\d+)$/);
  if (range) return `${range[1]}-${range[2]}`;
  const s = v.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function ghlFetch(path: string, init: RequestInit & { method: string }, retry = true): Promise<any> {
  const c = ghlConfig();
  if (!c) throw new Error("GHL not configured");
  const run = async () => {
    const res = await fetch(`${GHL_BASE}${path}`, {
      ...init,
      // Bound every GHL write so a hung upstream throws (classed transient → retried for idempotent calls)
      // instead of holding the whole serverless function open to its platform limit. Honour a caller signal.
      // Shared with the read client via GHL_TIMEOUT_MS so the two can never drift apart.
      signal: init.signal ?? AbortSignal.timeout(GHL_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${c.key}`, Version: GHL_VERSION, "Content-Type": "application/json", Accept: "application/json" },
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!res.ok) throw new Error(`GHL ${path} ${res.status}: ${String(text).slice(0, 200)}`);
    return json;
  };
  // retry=false is for NON-idempotent calls (task create): a 504 whose request actually landed would
  // duplicate on auto-retry. Everything else keeps the transient-blip retry.
  return retry ? withGhlRetry(run) : run();
}

export { fieldFingerprint };

// Per-process cache of fingerprint → field id, so we don't re-list on every lead.
let fieldCache: Map<string, string> | null = null;

/** Every GHL custom field, for the launcher's mapping preview. */
export async function listGhlFields(): Promise<Array<{ id: string; name: string; fieldKey: string }>> {
  const c = ghlConfig();
  if (!c) return [];
  const j = await ghlFetch(`/locations/${c.location}/customFields`, { method: "GET" });
  const fields: any[] = j.customFields ?? j.customField ?? [];
  return fields
    .filter((f) => f?.id && f?.name)
    .map((f) => ({ id: String(f.id), name: String(f.name), fieldKey: String(f.fieldKey ?? "") }));
}

async function loadFields(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of await listGhlFields()) {
    // Index by BOTH the display name and GHL's own fieldKey — either can match a question's label.
    for (const src of [f.name, f.fieldKey]) {
      const fp = fieldFingerprint(src ?? "");
      if (fp && !m.has(fp)) m.set(fp, f.id);
    }
  }
  // Operator pins win over fingerprint matches: they're the answer to "this reworded question is really
  // that existing field", which no amount of normalising could infer safely.
  try {
    const tenantId = await getPrimaryTenantId();
    if (tenantId) {
      const { data } = await createAdminClient().from("ghl_field_pins").select("fingerprint, ghl_field_id").eq("tenant_id", tenantId);
      for (const p of (data ?? []) as Array<{ fingerprint: string; ghl_field_id: string }>) {
        if (p.fingerprint && p.ghl_field_id) m.set(p.fingerprint, p.ghl_field_id);
      }
    }
  } catch {
    // Pins are an enhancement — never let them break the push.
  }
  return m;
}

/**
 * GHL custom field id for `name`: reuse whatever existing field means the same thing, and only create one
 * (contact-level, single-line, in the ADS folder) when there is genuinely nothing to match.
 */
export async function ensureField(name: string): Promise<string> {
  const clean = name.trim();
  const fp = fieldFingerprint(clean);
  if (!fieldCache) fieldCache = await loadFields();
  const hit = fieldCache.get(fp);
  if (hit) return hit;

  const c = ghlConfig()!;
  const body: Record<string, unknown> = { name: clean, dataType: "TEXT", model: "contact" };
  if (c.folder) body.parentId = c.folder;
  try {
    const j = await ghlFetch(`/locations/${c.location}/customFields`, { method: "POST", body: JSON.stringify(body) });
    const id = j?.customField?.id ?? j?.id;
    if (!id) throw new Error(`GHL custom field create returned no id for "${clean}"`);
    fieldCache.set(fp, String(id));
    return String(id);
  } catch (e: any) {
    // Last line of defence: GHL rejects a name whose slug already exists — and hands us the winner's id in
    // the error. Adopt it instead of letting the lead die. Fingerprinting should have caught this above, so
    // reaching here means GHL's slug rule diverged from ours; either way, the lead still lands.
    const existing = String(e?.message ?? "").match(/"existingId"\s*:\s*"([^"]+)"/)?.[1];
    if (existing) {
      fieldCache.set(fp, existing);
      return existing;
    }
    throw e;
  }
}

interface UpsertArgs {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null; // company site inferred from a professional email domain
  customFields?: Array<{ id: string; value: string }>;
  tags?: string[];
}
interface ContactField {
  id: string;
  value: string;
}

/** Raw upsert (GHL dedupes by phone/email). Returns the id, whether it was newly created, and its fields. */
async function upsertContactRaw(args: UpsertArgs): Promise<{ id: string; isNew: boolean; customFields: ContactField[] }> {
  const c = ghlConfig()!;
  const body: Record<string, unknown> = { locationId: c.location };
  if (args.name) body.name = args.name;
  if (args.phone) body.phone = args.phone;
  if (args.email) body.email = args.email;
  if (args.website) body.website = args.website;
  if (args.customFields?.length) body.customFields = args.customFields;
  if (args.tags?.length) body.tags = args.tags;
  const j = await ghlFetch(`/contacts/upsert`, { method: "POST", body: JSON.stringify(body) });
  const contact = j?.contact ?? {};
  const id = contact.id ?? j?.id;
  if (!id) throw new Error("GHL contact upsert returned no id");
  const customFields: ContactField[] = Array.isArray(contact.customFields)
    ? contact.customFields.map((f: any) => ({ id: String(f.id), value: String(f.value ?? f.field_value ?? "") }))
    : [];
  return { id: String(id), isNew: !!j?.new, customFields };
}

/** Upsert a contact (GHL dedupes by phone/email) with optional custom fields + tags. Returns the contact id. */
export async function upsertContact(args: UpsertArgs): Promise<string> {
  return (await upsertContactRaw(args)).id;
}

/**
 * Update a known contact in place (PUT — no upsert/dedupe involved). Used by the Leads-tab contact
 * edits. GHL rejects a phone/email that already belongs to another contact; the caller surfaces that.
 */
export async function updateGhlContact(
  contactId: string,
  patch: {
    phone?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    name?: string; // full-name form, used when reverting to Meta's original (no first/last split known)
    website?: string;
    // GHL's NATIVE company field — the dashboard's Company column mirrors into it. To CLEAR it send
    // null, NOT "": live-tested 2026-07-23 — GHL returns 200 for an empty string but silently keeps
    // the old value; null actually empties the field.
    companyName?: string | null;
    customFields?: Array<{ id: string; value: string }>;
  }
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.phone !== undefined) body.phone = patch.phone;
  if (patch.email !== undefined) body.email = patch.email;
  if (patch.firstName !== undefined) body.firstName = patch.firstName;
  if (patch.lastName !== undefined) body.lastName = patch.lastName;
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.website !== undefined) body.website = patch.website;
  if (patch.companyName !== undefined) body.companyName = patch.companyName;
  if (patch.customFields?.length) body.customFields = patch.customFields;
  if (Object.keys(body).length === 0) return;
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, { method: "PUT", body: JSON.stringify(body) });
}

/**
 * Flip exactly one logical state (qualification or call state) on a contact's tags without disturbing any
 * OTHER tag it carries (client-*, nurture, etc.). NEVER route this through PUT /contacts or /contacts/upsert:
 * their `tags` field REPLACES the whole set and would wipe every unrelated tag. Uses the scoped add/remove
 * tag endpoints instead.
 *
 * Order is load-bearing — REMOVE first, then ADD. The reader gives the positive tag (`qualified`/`contacted`)
 * precedence, so if we added first and the remove leg then failed, the contact would hold both tags and latch
 * on the positive one forever. Remove-first fails safe: a dead add leaves neither tag → the lead reads back as
 * the neutral state → visibly incomplete and simply re-clickable.
 *
 * `remove` is matched case-insensitively against the contact's CURRENT tags (from the last sync) so a stored
 * "Unqualified"/"DQ" variant is stripped too. Returns the resulting tag list for the caller to cache.
 */
export async function setContactTagState(
  contactId: string,
  currentTags: string[],
  opts: { remove: readonly string[]; add: string | null }
): Promise<string[]> {
  const removeSet = new Set(opts.remove.map((t) => t.toLowerCase().trim()));
  // Only remove tags the contact actually has (avoids a needless call, and any ambiguity about removing a
  // tag that isn't there). Preserve GHL's own casing when calling remove.
  const toRemove = currentTags.filter((t) => removeSet.has(t.toLowerCase().trim()));
  const cid = encodeURIComponent(contactId);
  if (toRemove.length) {
    await ghlFetch(`/contacts/${cid}/tags`, { method: "DELETE", body: JSON.stringify({ tags: toRemove }) });
  }
  if (opts.add) {
    const j = await ghlFetch(`/contacts/${cid}/tags`, { method: "POST", body: JSON.stringify({ tags: [opts.add] }) });
    // The add endpoint returns the full resulting tag list — trust it over local reconstruction.
    if (Array.isArray(j?.tags)) return j.tags.map((t: unknown) => String(t));
  }
  // No add (→ neutral state), or the add response lacked a tag list: reconstruct locally.
  const removed = new Set(toRemove.map((t) => t.toLowerCase().trim()));
  const next = currentTags.filter((t) => !removed.has(t.toLowerCase().trim()));
  if (opts.add && !next.some((t) => t.toLowerCase().trim() === opts.add!.toLowerCase().trim())) next.push(opts.add);
  return next;
}

/** Read a contact's CURRENT tags straight from GoHighLevel (source of truth). Used to reconcile the local
 *  cache after a tag write, so a remove-only change (which setContactTagState reconstructs locally) or a
 *  concurrent operator's edit can't leave leads.qualification / call_state diverged from GHL. */
export async function fetchContactTags(contactId: string): Promise<string[]> {
  const j = await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, { method: "GET" });
  const tags = j?.contact?.tags;
  return Array.isArray(tags) ? tags.map((t: unknown) => String(t)) : [];
}

/**
 * Create an open task on a contact (the dashboard's follow-up reminder — "Call again" etc.).
 * GHL normalizes dueDate to UTC ISO in the response; return the task as stored so the caller can
 * mirror exactly what GHL holds.
 */
export async function createContactTask(
  contactId: string,
  title: string,
  dueIso: string
): Promise<{ id: string; title: string; dueIso: string | null }> {
  // Single attempt on purpose: POST /tasks creates a new row every time, so withGhlRetry's 504/network
  // retry could double-create. A transient blip surfaces to the operator, whose click IS the safe retry.
  const j = await ghlFetch(
    `/contacts/${encodeURIComponent(contactId)}/tasks`,
    { method: "POST", body: JSON.stringify({ title, dueDate: dueIso, completed: false }) },
    false
  );
  const t = j?.task ?? {};
  if (!t.id) throw new Error("GHL task create returned no id");
  return { id: String(t.id), title: String(t.title ?? title), dueIso: t.dueDate ? String(t.dueDate) : null };
}

/** Mark a contact task done. Idempotent from our side: GHL answers a missing task with 404 — the caller
 *  treats that as already-done and re-syncs. */
export async function completeContactTask(contactId: string, taskId: string): Promise<void> {
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}/completed`, {
    method: "PUT",
    body: JSON.stringify({ completed: true }),
  });
}

/**
 * Reschedule (or rename) an OPEN contact task in place — same task, new due date. This is what "push
 * to tomorrow" needs: without it the only way to move a task was delete + re-create, which loses the
 * task's identity and its history in GoHighLevel, and briefly leaves the lead with no reminder at all.
 *
 * GHL's PUT requires the full title alongside the date, so callers pass the current title through.
 * Retried like the other idempotent writes: setting the same due date twice is a no-op, so unlike
 * create there's no double-write hazard.
 */
export async function updateContactTask(
  contactId: string,
  taskId: string,
  patch: { title: string; dueIso: string }
): Promise<{ id: string; title: string; dueIso: string | null }> {
  const j = await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body: JSON.stringify({ title: patch.title, dueDate: patch.dueIso }),
  });
  const t = j?.task ?? {};
  return { id: String(t.id ?? taskId), title: String(t.title ?? patch.title), dueIso: t.dueDate ? String(t.dueDate) : patch.dueIso };
}

/** Permanently delete a contact task — no completed record left in GHL (vs completeContactTask, which
 *  keeps it as done). A missing task errors like complete does; callers treat that as already gone. */
export async function deleteContactTask(contactId: string, taskId: string): Promise<void> {
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}

/**
 * Write a booking's attendance back to GoHighLevel. Showed / no-show / cancelled are GHL's OWN
 * appointment vocabulary, so recording them here keeps the CRM's calendar honest for anyone working
 * inside GHL rather than only lighting up the dashboard.
 *
 * Our vocabulary maps 1:1 onto theirs (`scheduled` is GHL's `confirmed`). Idempotent — setting the same
 * status twice is a no-op — so it retries like the other safe writes.
 */
const GHL_APPT_STATUS: Record<string, string> = {
  scheduled: "confirmed",
  showed: "showed",
  no_show: "noshow",
  cancelled: "cancelled",
};
export async function updateAppointmentStatus(appointmentId: string, attendance: string): Promise<void> {
  const appointmentStatus = GHL_APPT_STATUS[attendance];
  if (!appointmentStatus) throw new Error(`unknown attendance "${attendance}"`);
  await ghlFetch(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, {
    method: "PUT",
    body: JSON.stringify({ appointmentStatus }),
  });
}

/**
 * Opportunities — GHL is the store; a GHL workflow creates one when a meeting is booked, sync
 * discovers it by contact and links it to the lead, the dashboard writes value/status back.
 */
export interface GhlOpportunity {
  id: string;
  name: string | null;
  monetaryValue: number | null;
  status: string; // open | won | lost | abandoned
  pipelineId: string | null;
  pipelineStageId: string | null;
  createdAt: string | null;
  /** The contact this deal belongs to — needed to join a pipeline board back to the dashboard's leads. */
  contactId: string | null;
  /** The contact's name as GHL carries it on the deal (fallback when no lead is linked). */
  contactName: string | null;
  /** Last time GHL touched the deal (stage move / edit) — the board's "last activity". */
  updatedAt: string | null;
}

const mapOpportunity = (o: any): GhlOpportunity => ({
  id: String(o.id),
  name: o.name ? String(o.name) : null,
  monetaryValue: o.monetaryValue == null ? null : Number(o.monetaryValue),
  status: String(o.status ?? "open"),
  pipelineId: o.pipelineId ? String(o.pipelineId) : null,
  pipelineStageId: o.pipelineStageId ? String(o.pipelineStageId) : null,
  createdAt: o.createdAt ? String(o.createdAt) : null,
  contactId: o.contactId ? String(o.contactId) : o.contact?.id ? String(o.contact.id) : null,
  contactName: o.contact?.name ? String(o.contact.name) : o.contact?.contactName ? String(o.contact.contactName) : null,
  updatedAt: o.lastStageChangeAt ? String(o.lastStageChangeAt) : o.updatedAt ? String(o.updatedAt) : null,
});

/** One GHL pipeline and its ordered stages — the columns of a Pipeline kanban. */
export interface GhlPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; position: number }[];
}

/** Every pipeline in the location, each with its stages in board order. Powers the Pipeline tab's
 *  columns + picker. (The stage list was previously fetched only inside moveOpportunityToWonStage.) */
export async function listPipelines(): Promise<GhlPipeline[]> {
  const c = ghlConfig();
  if (!c) return [];
  const j = await ghlFetch(`/opportunities/pipelines?locationId=${encodeURIComponent(c.location)}`, { method: "GET" });
  return (j?.pipelines ?? []).map((p: any) => ({
    id: String(p.id),
    name: String(p.name ?? "Pipeline"),
    stages: (p.stages ?? [])
      .map((s: any, i: number) => ({ id: String(s.id), name: String(s.name ?? ""), position: typeof s.position === "number" ? s.position : i }))
      .sort((a: { position: number }, b: { position: number }) => a.position - b.position),
  }));
}

/** Every opportunity in one pipeline (paginated — GHL caps 100/page), mapped to GhlOpportunity with the
 *  contact object kept. This is the board's card set: a faithful mirror of the GHL pipeline. */
export async function listOpportunitiesInPipeline(pipelineId: string): Promise<GhlOpportunity[]> {
  const c = ghlConfig();
  if (!c) return [];
  const out: GhlOpportunity[] = [];
  const LIMIT = 100;
  const MAX_PAGES = 25; // safety cap (2,500 deals)
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await ghlFetch(
      `/opportunities/search?location_id=${encodeURIComponent(c.location)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=${LIMIT}&page=${page}`,
      { method: "GET" }
    );
    const opps: any[] = j?.opportunities ?? [];
    for (const o of opps) out.push(mapOpportunity(o));
    if (opps.length < LIMIT) break;
  }
  return out;
}

/** Move an opportunity to an arbitrary pipeline stage. Unlike moveOpportunityToWonStage this THROWS on
 *  failure, so a drag-to-move UI can revert the card when GHL rejects the write. */
export async function moveOpportunityToStage(opportunityId: string, pipelineId: string, stageId: string): Promise<void> {
  await ghlFetch(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: "PUT",
    body: JSON.stringify({ pipelineId, pipelineStageId: stageId }),
  });
}

/** Every opportunity attached to a contact (usually 0 or 1). */
export async function fetchOpportunitiesByContact(contactId: string): Promise<GhlOpportunity[]> {
  const c = ghlConfig();
  if (!c) return [];
  const j = await ghlFetch(`/opportunities/search?location_id=${encodeURIComponent(c.location)}&contact_id=${encodeURIComponent(contactId)}`, { method: "GET" });
  return (j?.opportunities ?? []).map(mapOpportunity);
}

/** Set the deal value on an opportunity. Idempotent PUT → keeps the transient-blip retry.
 *  `status` is null when GHL's response carried no opportunity envelope — callers must treat that as
 *  "unknown, keep what you had", never default it (a fabricated "open" once flipped a won deal back). */
export async function updateOpportunityValue(
  opportunityId: string,
  valueEur: number
): Promise<{ id: string; monetaryValue: number | null; status: string | null }> {
  const j = await ghlFetch(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: "PUT",
    body: JSON.stringify({ monetaryValue: valueEur }),
  });
  const o = j?.opportunity;
  return {
    id: o?.id ? String(o.id) : opportunityId,
    monetaryValue: o?.monetaryValue == null ? valueEur : Number(o.monetaryValue),
    status: o?.status ? String(o.status) : null,
  };
}

/** Flip an opportunity's status (open ↔ won/lost). Dedicated GHL status endpoint; idempotent. */
export async function updateOpportunityStatus(opportunityId: string, status: "open" | "won" | "lost"): Promise<void> {
  await ghlFetch(`/opportunities/${encodeURIComponent(opportunityId)}/status`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

/** Best-effort stage move to the pipeline's own "Won" stage so his GHL board reflects the close.
 *  No-op when the opportunity's pipeline has no stage named Won. Never throws — status is the truth. */
export async function moveOpportunityToWonStage(opp: { id: string; pipelineId: string | null }): Promise<void> {
  try {
    const c = ghlConfig();
    if (!c || !opp.pipelineId) return;
    const j = await ghlFetch(`/opportunities/pipelines?locationId=${encodeURIComponent(c.location)}`, { method: "GET" });
    const pipeline = (j?.pipelines ?? []).find((p: any) => String(p.id) === opp.pipelineId);
    const won = (pipeline?.stages ?? []).find((s: any) => String(s.name ?? "").trim().toLowerCase() === "won");
    if (!won?.id) return;
    await moveOpportunityToStage(opp.id, opp.pipelineId, String(won.id));
  } catch {
    /* stage move is cosmetic — the won STATUS already landed */
  }
}

/** Add a free-text note to a contact (the Leads-tab call log). `userId` (author) is optional in GHL —
 *  included only when GHL_USER_ID is configured, so notes attribute to a real user when we have one. */
export async function createContactNote(contactId: string, body: string): Promise<{ id: string; body: string; createdAt: string | null }> {
  const payload: Record<string, unknown> = { body };
  if (process.env.GHL_USER_ID) payload.userId = process.env.GHL_USER_ID;
  // Single attempt: POST /notes creates a new note every time, so a 504-then-retry could double-post.
  const j = await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/notes`, { method: "POST", body: JSON.stringify(payload) }, false);
  const n = j?.note ?? {};
  if (!n.id) throw new Error("GHL note create returned no id");
  return { id: String(n.id), body: String(n.body ?? body), createdAt: n.dateAdded ? String(n.dateAdded) : null };
}

/** Edit an existing contact note's body. Idempotent (PUT to the same note) → keeps the transient-blip retry. */
export async function updateContactNote(contactId: string, noteId: string, body: string): Promise<{ id: string; body: string; createdAt: string | null }> {
  const payload: Record<string, unknown> = { body };
  if (process.env.GHL_USER_ID) payload.userId = process.env.GHL_USER_ID;
  const j = await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`, { method: "PUT", body: JSON.stringify(payload) });
  const n = j?.note ?? {};
  return { id: String(n.id ?? noteId), body: String(n.body ?? body), createdAt: n.dateAdded ? String(n.dateAdded) : null };
}

/** Delete one contact note. Idempotent: a missing note (404) means it's already gone, so the delete's
 *  goal is already achieved — swallow it. Any other failure (a real transport/5xx error) still throws so
 *  the caller can surface it. Without this, a second operator deleting an already-deleted note got a 502
 *  and the client re-inserted the (gone) note with a false error. */
export async function deleteContactNote(contactId: string, noteId: string): Promise<void> {
  try {
    await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof Error && /\s404\b/.test(e.message)) return;
    throw e;
  }
}

/** Read whether one custom field is empty on a contact — write-once fallback when upsert omits fields. */
async function isFieldEmpty(contactId: string, fieldId: string): Promise<boolean> {
  try {
    const j = await ghlFetch(`/contacts/${contactId}`, { method: "GET" });
    const cf: any[] = j?.contact?.customFields ?? [];
    const hit = cf.find((f) => String(f.id) === fieldId);
    return !hit || !String(hit.value ?? hit.field_value ?? "").trim();
  } catch (e: any) {
    // Can't confirm → don't risk clobbering an existing first-touch value, but surface it so a persistent
    // GHL read failure silently dropping first-touch attribution is visible rather than silent (C35).
    console.warn(`isFieldEmpty read failed for contact ${contactId} — skipping first-touch write this pass:`, e?.message ?? e);
    return false;
  }
}

export interface SourceWrite {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null; // operator-set website; when absent the email-domain inference applies
  label: string; // the "Channel — Detail" string (→ Conversion Source on conversions)
  /** The attribution channel alone — fills the "Lead Source" dropdown (write-once) via originOptionForChannel. */
  channel?: string | null;
  setConversion: boolean; // true on the conversion (completed); false on started
  adName?: string | null; // → Anúncio
  extraFields?: Array<{ id: string; value: string }>; // e.g. the answer fields
  tags?: string[];
}

/**
 * Upsert a contact and write attribution: Conversion Source ("Channel — Detail", when `setConversion`),
 * Anúncio, any extra fields, plus the Lead Source DROPDOWN written ONCE (first touch — never overwrites
 * the operator's choice). The old free-text Lead Source field was deleted 2026-07-23 (Miguel): the
 * detailed label now lives only on Conversion Source; the dropdown carries the channel option.
 */
export async function writeContactWithSource(a: SourceWrite): Promise<string> {
  const convFieldId = await ensureField(CONVERSION_SOURCE_FIELD);

  const fields: Array<{ id: string; value: string }> = [...(a.extraFields ?? [])];
  if (a.adName) fields.push({ id: await ensureField(AD_FIELD_NAME), value: a.adName });
  if (a.setConversion) fields.push({ id: convFieldId, value: a.label });

  const { id, isNew, customFields } = await upsertContactRaw({
    name: a.name,
    phone: a.phone,
    email: a.email,
    // Operator-set website wins; otherwise a professional email domain IS the company's website.
    // null/undefined → the upsert omits the key entirely, so a curated website in GHL is never cleared.
    website: a.website ?? companyDomainFromEmail(a.email),
    customFields: fields,
    tags: a.tags,
  });

  // Lead Source dropdown = write-once first touch: set only when brand-new or currently empty, so the
  // operator's manual selection is never overwritten by automation.
  const sourceFieldId = await ensureField(LEAD_SOURCE_FIELD);
  const alreadySet = customFields.some((f) => f.id === sourceFieldId && f.value.trim());
  let empty = !alreadySet;
  if (!isNew && !alreadySet && customFields.length === 0) {
    empty = await isFieldEmpty(id, sourceFieldId); // upsert didn't echo fields — confirm before deciding
  }
  if (isNew || empty) {
    await upsertContactRaw({ phone: a.phone, email: a.email, customFields: [{ id: sourceFieldId, value: originOptionForChannel(a.channel) }] });
  }
  return id;
}
