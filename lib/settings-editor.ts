import { createAdminClient } from "./supabase/admin";
import { getPrimaryTenantId } from "./tenant";

export interface EditorSetting {
  key: string;
  label: string;
  /** "longtext" = multi-line (WhatsApp templates); rendered as a textarea rather than a single-line input. */
  value_type: "currency" | "percent" | "days" | "ratio" | "count" | "enum" | "boolean" | "url" | "text" | "longtext";
  unit: string | null;
  default_value: any;
  suggested_min: any;
  suggested_max: any;
  enum_options: string[] | null;
  used_by: string | null;
  current: any;
  overridden: boolean;
}

export async function getSettingsEditor(): Promise<EditorSetting[]> {
  const sb = createAdminClient();
  const tenantId = await getPrimaryTenantId();

  const [defs, over] = await Promise.all([
    sb.from("setting_definitions").select("*").order("key", { ascending: true }),
    tenantId
      ? sb.from("tenant_settings").select("key,value").eq("tenant_id", tenantId)
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);
  if (defs.error) throw defs.error;

  const ov = new Map<string, any>();
  for (const r of (over as any).data ?? []) ov.set(r.key, r.value);

  return (defs.data ?? []).map((d: any) => ({
    key: d.key,
    label: d.label,
    value_type: d.value_type,
    unit: d.unit,
    default_value: d.default_value,
    suggested_min: d.suggested_min,
    suggested_max: d.suggested_max,
    enum_options: d.enum_options,
    used_by: d.used_by,
    current: ov.has(d.key) ? ov.get(d.key) : d.default_value,
    overridden: ov.has(d.key),
  }));
}
