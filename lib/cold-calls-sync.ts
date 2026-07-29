import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readTab } from "@/lib/google-sheets";
import { normalizeTab, COLD_CALLS_SHEET_ID, COLD_CALLS_TAB, type ColdCallContact } from "@/lib/cold-calls";

export type SyncSummary = { total: number; inserted: number; updated: number; flaggedRemoved: number };

const emailNorm = (e: string) => e.trim().toLowerCase() || null;
const phoneNorm = (p: string) => {
  const v = p.replace(/[^\d+]/g, "");
  return v || null;
};

/** Roster/firmographic columns — owned by the sheet, refreshed on every pull (never call-state). */
function rosterColumns(c: ColdCallContact) {
  return {
    source_tab: COLD_CALLS_TAB,
    sheet_row: c.sheetRow,
    first_name: c.firstName || null,
    last_name: c.lastName || null,
    full_name: c.fullName || null,
    role: c.role || null,
    tier: c.tier || null,
    seniority: c.seniority || null,
    department: c.department || null,
    email: c.email || null,
    email_norm: emailNorm(c.email),
    phone: c.phone || null,
    phone_norm: phoneNorm(c.phone),
    country: c.country || null,
    person_linkedin: c.personLinkedin || null,
    company_name: c.companyName || null,
    company_short_name: c.companyShortName || null,
    company_linkedin: c.companyLinkedin || null,
    website: c.website || null,
    industry_group: c.industryGroup || null,
    industry: c.industry || null,
    niche: c.niche || null,
    employees: c.employees,
    company_size: c.companySize || null,
    company_about: c.companyAbout || null,
    company_industry_li: c.companyIndustryLi || null,
    deleted_from_sheet_at: null as string | null, // reappeared rows get un-flagged
    sheet_synced_at: new Date().toISOString(),
  };
}

async function chunkedInsert(admin: SupabaseClient, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("cold_call_contacts").insert(rows.slice(i, i + 500));
    if (error) throw new Error(`cold_call_contacts insert: ${error.message}`);
  }
}

async function chunkedRosterUpsert(admin: SupabaseClient, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) {
    // onConflict updates ONLY the provided (roster) columns → call state (call_status / assigned_user /
    // notes / derived) is left untouched. That's the whole point: the dashboard owns call state.
    const { error } = await admin
      .from("cold_call_contacts")
      .upsert(rows.slice(i, i + 500), { onConflict: "tenant_id,dedupe_key" });
    if (error) throw new Error(`cold_call_contacts roster upsert: ${error.message}`);
  }
}

/**
 * Pull the sheet → cold_call_contacts. New rows are SEEDED with the sheet's Call Status / Assigned User /
 * Notes; existing rows only get their roster fields refreshed (call state is preserved). Rows that vanish
 * from the sheet are soft-flagged (deleted_from_sheet_at), never deleted.
 */
export async function syncColdCallsFromSheet(admin: SupabaseClient, tenantId: string): Promise<SyncSummary> {
  const tab = await readTab(COLD_CALLS_SHEET_ID, COLD_CALLS_TAB);
  const contacts = normalizeTab(tab);

  // Dedupe within the sheet (first row wins) so a key maps to exactly one contact.
  const byKey = new Map<string, ColdCallContact>();
  for (const c of contacts) if (!byKey.has(c.key)) byKey.set(c.key, c);

  // Which keys already exist in the DB?
  const existing = new Set<string>();
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("cold_call_contacts")
      .select("dedupe_key")
      .eq("tenant_id", tenantId)
      .range(start, start + 999);
    if (error) throw new Error(`cold_call_contacts read: ${error.message}`);
    for (const r of data ?? []) existing.add(r.dedupe_key as string);
    if (!data || data.length < 1000) break;
  }

  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  for (const [key, c] of byKey) {
    const roster = { ...rosterColumns(c), tenant_id: tenantId, dedupe_key: key };
    if (existing.has(key)) {
      updates.push(roster);
    } else {
      // Seed call state from the sheet ONCE, on first import.
      inserts.push({ ...roster, call_status: c.callStatus, assigned_user: c.assignedUser || null, notes: c.notes || null });
    }
  }

  await chunkedInsert(admin, inserts);
  await chunkedRosterUpsert(admin, updates);

  // Soft-flag contacts that are no longer in the sheet.
  let flaggedRemoved = 0;
  const missing = [...existing].filter((k) => !byKey.has(k));
  for (let i = 0; i < missing.length; i += 200) {
    const slice = missing.slice(i, i + 200);
    const { error, count } = await admin
      .from("cold_call_contacts")
      .update({ deleted_from_sheet_at: new Date().toISOString() }, { count: "exact" })
      .eq("tenant_id", tenantId)
      .in("dedupe_key", slice)
      .is("deleted_from_sheet_at", null);
    if (error) throw new Error(`cold_call_contacts flag-removed: ${error.message}`);
    flaggedRemoved += count ?? 0;
  }

  return { total: byKey.size, inserted: inserts.length, updated: updates.length, flaggedRemoved };
}
