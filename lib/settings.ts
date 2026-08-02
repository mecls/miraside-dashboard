/**
 * Runtime settings resolver — reads a setting's CURRENT value (tenant override on top of the
 * definition default). Used by the backend for the URL settings (destination + privacy), which must
 * honor the admin's overrides from the Settings page. (lib/queries.ts reads only defaults for the ROI
 * engine; this is the override-aware path.)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "./supabase/admin";
import { getPrimaryTenantId } from "./tenant";

// Hard fallbacks if a setting row is somehow missing — NEVER the privacy page for a destination.
export const DEFAULT_WEBSITE_URL = "https://miraside.co";
export const DEFAULT_PRIVACY_URL = "https://dashboard.miraside.co/privacy";

/** Resolve the current values (override → default) for the given setting keys. */
export async function getSettingValues(
  keys: string[],
  admin?: SupabaseClient,
  tenantId?: string | null
): Promise<Record<string, unknown>> {
  const sb = admin ?? createAdminClient();
  const tid = tenantId ?? (await getPrimaryTenantId());
  const [defs, over] = await Promise.all([
    sb.from("setting_definitions").select("key,default_value").in("key", keys),
    tid
      ? sb.from("tenant_settings").select("key,value").eq("tenant_id", tid).in("key", keys)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const out: Record<string, unknown> = {};
  for (const d of (defs as any).data ?? []) out[d.key] = d.default_value;
  for (const o of (over as any).data ?? []) out[o.key] = o.value;
  return out;
}

const cleanUrl = (v: unknown, fallback: string): string => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https?:\/\/.+/i.test(s) ? s : fallback;
};

/**
 * The two destination URLs the launcher + lead forms need:
 *  - defaultWebsiteUrl: the standard destination (landing-page default, instant-form after-submit
 *    default, and the cosmetic link Meta requires on form ads). NEVER the privacy page.
 *  - privacyUrl: the form's legally-required privacy-policy link (not a destination).
 */
export async function getUrlSettings(
  admin?: SupabaseClient,
  tenantId?: string | null
): Promise<{ defaultWebsiteUrl: string; privacyUrl: string }> {
  const v = await getSettingValues(["default_website_url", "privacy_policy_url"], admin, tenantId);
  return {
    defaultWebsiteUrl: cleanUrl(v.default_website_url, DEFAULT_WEBSITE_URL),
    privacyUrl: cleanUrl(v.privacy_policy_url, DEFAULT_PRIVACY_URL),
  };
}
