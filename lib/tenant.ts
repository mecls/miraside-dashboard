import { createAdminClient } from "./supabase/admin";

/** Single-tenant phase: the first (and only) tenant. Replaced by auth-derived tenant later. */
export async function getPrimaryTenantId(): Promise<string | null> {
  const sb = createAdminClient();
  const { data } = await sb
    .from("tenants")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
