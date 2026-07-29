/**
 * Cold Calls domain model — maps rows of the "Portugal Leads" Google Sheet
 * (tab "A - Leads (nº PT)") into typed contacts the dashboard can render.
 *
 * The sheet stays the source of truth for the roster + the current Call
 * Status / Assigned User / Notes; richer call history is layered on top in
 * Supabase (added in a later phase). See lib/google-sheets.ts for the client.
 */
/**
 * Shape returned by lib/google-sheets `readTab`. Declared here (not imported
 * from google-sheets) so this module stays client-safe — it must never pull in
 * the Node-only googleapis bundle, since the "use client" ColdCallsView imports
 * CALL_STATUSES / types from here.
 */
export type RawTab = { header: string[]; rows: unknown[][] };

export const COLD_CALLS_SHEET_ID =
  process.env.COLD_CALLS_SHEET_ID || "1R21Fyy88buu1HlLISoF11FpRYWmqRXiISt5ti6zGZzY";
export const COLD_CALLS_TAB = process.env.COLD_CALLS_TAB || "A - Leads (nº PT)";

/** Canonical call statuses seen in the sheet, in funnel order. Free text is preserved as-is. */
export const CALL_STATUSES = [
  "Not called",
  "No answer",
  "Called",
  "Follow up",
  "Not interested",
  "Not a fit",
  "Meeting booked",
  "Invalid number",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number] | (string & {});

export type Tone = "neutral" | "info" | "good" | "warn" | "bad" | "muted";

/** Map a (possibly messy) status string to a normalized label + display tone. */
export function normalizeStatus(raw: string | undefined): { status: CallStatus; tone: Tone } {
  const s = (raw || "").trim();
  const k = s.toLowerCase();
  if (!k) return { status: "Not called", tone: "muted" };
  if (k.includes("meeting") || k.includes("booked") || k.includes("marcad")) return { status: "Meeting booked", tone: "good" };
  if (k.includes("follow")) return { status: "Follow up", tone: "info" };
  if (k.includes("no answer") || k.includes("no-answer") || k.includes("sem resposta")) return { status: "No answer", tone: "warn" };
  if (k.includes("invalid") || k.includes("wrong") || k.includes("inválid")) return { status: "Invalid number", tone: "bad" };
  if (k.includes("not interested") || k.includes("não interess")) return { status: "Not interested", tone: "bad" };
  if (k.includes("not a fit") || k.includes("unqualified") || k.includes("desqualif")) return { status: "Not a fit", tone: "bad" };
  if (k.includes("not called") || k === "—" || k === "-") return { status: "Not called", tone: "muted" };
  if (k.includes("called") || k.includes("contact")) return { status: "Called", tone: "neutral" };
  return { status: s, tone: "neutral" }; // preserve anything unexpected
}

export interface ColdCallContact {
  /** 1-based row number in the sheet (header is row 1; first data row is row 2). */
  sheetRow: number;
  /** Stable-ish key for dedupe / matching: email → phone → linkedin → row. */
  key: string;
  firstName: string;
  lastName: string;
  fullName: string;
  role: string;
  tier: string;
  seniority: string;
  department: string;
  email: string;
  phone: string;
  countryFlag: string; // raw emoji as stored
  country: string; // resolved name where possible
  assignedUser: string;
  personLinkedin: string;
  companyName: string;
  companyShortName: string;
  companyLinkedin: string;
  website: string;
  industryGroup: string;
  industry: string;
  niche: string;
  employees: number | null;
  companySize: string;
  companyAbout: string;
  companyIndustryLi: string;
  callStatus: CallStatus;
  statusTone: Tone;
  notes: string;
}

const FLAG_TO_COUNTRY: Record<string, string> = {
  PT: "Portugal", ES: "Spain", GB: "United Kingdom", US: "United States",
  FR: "France", DE: "Germany", BR: "Brazil", IT: "Italy", NL: "Netherlands",
  CH: "Switzerland", IE: "Ireland", BE: "Belgium", LU: "Luxembourg",
  AE: "United Arab Emirates", AO: "Angola", CV: "Cape Verde",
};

/** Convert a 🇵🇹-style flag emoji into a country name (falls back to the ISO letters, then ""). */
function resolveCountry(flag: string): string {
  const f = (flag || "").trim();
  if (!f) return "";
  const cps = [...f].map((c) => c.codePointAt(0) || 0).filter((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff);
  if (cps.length === 2) {
    const iso = cps.map((cp) => String.fromCharCode(cp - 0x1f1e6 + 65)).join("");
    return FLAG_TO_COUNTRY[iso] || iso;
  }
  return f; // already a plain string like "Portugal"
}

const str = (v: unknown): string => (v == null ? "" : String(v).trim());

function buildColumnIndex(header: string[]): (name: string) => number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map<string, number>();
  header.forEach((h, i) => map.set(norm(h), i));
  return (name: string) => map.get(norm(name)) ?? -1;
}

/** Normalize a raw tab into typed contacts. */
export function normalizeTab(tab: RawTab): ColdCallContact[] {
  const col = buildColumnIndex(tab.header);
  const get = (row: unknown[], name: string) => {
    const i = col(name);
    return i < 0 ? "" : str(row[i]);
  };
  const out: ColdCallContact[] = [];
  tab.rows.forEach((row, idx) => {
    const firstName = get(row, "First Name");
    const lastName = get(row, "Last Name");
    const email = get(row, "Email");
    const phone = get(row, "Phone");
    const personLinkedin = get(row, "Person LinkedIn");
    // Skip fully-empty rows (trailing blanks the sheet often carries).
    if (!firstName && !lastName && !email && !phone && !get(row, "Company Name")) return;
    const flag = get(row, "Country");
    const { status, tone } = normalizeStatus(get(row, "Call Status"));
    const empRaw = get(row, "Employees");
    const employees = empRaw ? Number(String(empRaw).replace(/[^0-9]/g, "")) || null : null;
    out.push({
      sheetRow: idx + 2,
      key: (email || phone || personLinkedin || `row-${idx + 2}`).toLowerCase(),
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
      role: get(row, "Role"),
      tier: get(row, "Tier"),
      seniority: get(row, "Seniority"),
      department: get(row, "Department"),
      email,
      phone,
      countryFlag: flag,
      country: resolveCountry(flag),
      assignedUser: get(row, "Assigned User"),
      personLinkedin,
      companyName: get(row, "Company Name"),
      companyShortName: get(row, "Company Short Name"),
      companyLinkedin: get(row, "Company LinkedIn"),
      website: get(row, "Website"),
      industryGroup: get(row, "Industry Group"),
      industry: get(row, "Industry"),
      niche: get(row, "Niche"),
      employees,
      companySize: get(row, "Company Size"),
      companyAbout: get(row, "Company About (LinkedIn)"),
      companyIndustryLi: get(row, "Company Industry (LinkedIn)"),
      callStatus: status,
      statusTone: tone,
      notes: get(row, "Notes"),
    });
  });
  return out;
}

/* ------------------------------------------------------------------ DB rows */

/** Outcomes you can log for a call (every status except the un-worked "Not called"). */
export const LOG_OUTCOMES = CALL_STATUSES.filter((s) => s !== "Not called");

/** A contact as stored in Supabase `cold_call_contacts` (roster from sheet + DB-owned call state). */
export interface ColdCallRow {
  id: string;
  sheetRow: number | null;
  sourceTab: string;
  firstName: string;
  lastName: string;
  fullName: string;
  role: string;
  tier: string;
  seniority: string;
  department: string;
  email: string;
  phone: string;
  country: string;
  personLinkedin: string;
  companyName: string;
  companyShortName: string;
  companyLinkedin: string;
  website: string;
  industryGroup: string;
  industry: string;
  niche: string;
  employees: number | null;
  companySize: string;
  companyAbout: string;
  companyIndustryLi: string;
  callStatus: CallStatus;
  statusTone: Tone;
  assignedUser: string;
  notes: string;
  attempts: number;
  reachedDecisionMaker: boolean | null;
  lastOutcome: string;
  lastAttemptAt: string | null;
  nextFollowUpAt: string | null;
}

/** Map a snake_case `cold_call_contacts` row into the camelCase shape the UI consumes. */
export function dbRowToColdCall(r: Record<string, unknown>): ColdCallRow {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const { status, tone } = normalizeStatus(s(r.call_status));
  return {
    id: s(r.id),
    sheetRow: (r.sheet_row as number) ?? null,
    sourceTab: s(r.source_tab),
    firstName: s(r.first_name),
    lastName: s(r.last_name),
    fullName: s(r.full_name) || [s(r.first_name), s(r.last_name)].filter(Boolean).join(" "),
    role: s(r.role),
    tier: s(r.tier),
    seniority: s(r.seniority),
    department: s(r.department),
    email: s(r.email),
    phone: s(r.phone),
    country: s(r.country),
    personLinkedin: s(r.person_linkedin),
    companyName: s(r.company_name),
    companyShortName: s(r.company_short_name),
    companyLinkedin: s(r.company_linkedin),
    website: s(r.website),
    industryGroup: s(r.industry_group),
    industry: s(r.industry),
    niche: s(r.niche),
    employees: (r.employees as number) ?? null,
    companySize: s(r.company_size),
    companyAbout: s(r.company_about),
    companyIndustryLi: s(r.company_industry_li),
    callStatus: status,
    statusTone: tone,
    assignedUser: s(r.assigned_user),
    notes: s(r.notes),
    attempts: (r.attempts as number) ?? 0,
    reachedDecisionMaker: (r.reached_decision_maker as boolean) ?? null,
    lastOutcome: s(r.last_outcome),
    lastAttemptAt: (r.last_attempt_at as string) ?? null,
    nextFollowUpAt: (r.next_follow_up_at as string) ?? null,
  };
}

export interface ColdCallActivity {
  id: string;
  calledAt: string;
  rep: string;
  channel: string;
  disposition: string;
  reachedDecisionMaker: boolean | null;
  objection: string;
  nextStep: string;
  followUpAt: string | null;
  notes: string;
}

export function dbRowToActivity(r: Record<string, unknown>): ColdCallActivity {
  const s = (v: unknown) => (v == null ? "" : String(v));
  return {
    id: s(r.id),
    calledAt: s(r.called_at),
    rep: s(r.rep),
    channel: s(r.channel) || "call",
    disposition: s(r.disposition),
    reachedDecisionMaker: (r.reached_decision_maker as boolean) ?? null,
    objection: s(r.objection),
    nextStep: s(r.next_step),
    followUpAt: (r.follow_up_at as string) ?? null,
    notes: s(r.notes),
  };
}
