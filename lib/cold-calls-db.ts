import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbRowToColdCall, dbRowToActivity, type ColdCallRow, type ColdCallActivity } from "@/lib/cold-calls";

// company_about / company_industry_li are omitted here on purpose — they're long free text not shown in
// the list, and shipping them for all ~1.4k rows would bloat the client payload.
const CONTACT_COLS =
  "id, sheet_row, source_tab, first_name, last_name, full_name, role, tier, seniority, department, email, phone, country, person_linkedin, company_name, company_short_name, company_linkedin, website, industry_group, industry, niche, employees, company_size, call_status, assigned_user, notes, attempts, reached_decision_maker, last_outcome, last_attempt_at, next_follow_up_at";

/** All active contacts (paged past PostgREST's 1000-row cap), newest sheet order surfaced by name. */
export async function fetchColdCallRows(admin: SupabaseClient, tenantId: string): Promise<ColdCallRow[]> {
  const rows: Record<string, unknown>[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("cold_call_contacts")
      .select(CONTACT_COLS)
      .eq("tenant_id", tenantId)
      .is("deleted_from_sheet_at", null)
      .order("sheet_row", { ascending: true, nullsFirst: false })
      .range(start, start + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data as Record<string, unknown>[]) ?? []));
    if (!data || data.length < 1000) break;
  }
  const mapped = rows.map(dbRowToColdCall);
  // Worked contacts (status ≠ "Not called") first, then "Not called". The DB already returns sheet_row
  // ascending and Array.sort is stable, so within each group rows stay in sheet order — which is the order
  // they were called (the user works the sheet top-to-bottom). Net effect: oldest-contacted surfaces at
  // the top, and the un-called rows follow as the live call queue.
  mapped.sort((a, b) => (a.callStatus !== "Not called" ? 0 : 1) - (b.callStatus !== "Not called" ? 0 : 1));
  return mapped;
}

export async function fetchColdCallActivities(
  admin: SupabaseClient,
  tenantId: string,
  contactId: string
): Promise<ColdCallActivity[]> {
  const { data, error } = await admin
    .from("cold_call_activities")
    .select("id, called_at, rep, channel, disposition, reached_decision_maker, objection, next_step, follow_up_at, notes")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("called_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data as Record<string, unknown>[]) ?? []).map(dbRowToActivity);
}

/** Most recent roster pull time (for the "synced Nm ago" indicator). */
export async function fetchColdCallsSyncedAt(admin: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await admin
    .from("cold_call_contacts")
    .select("sheet_synced_at")
    .eq("tenant_id", tenantId)
    .order("sheet_synced_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data?.sheet_synced_at as string | null) ?? null;
}
