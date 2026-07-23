import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { getPrimaryTenantId } from "@/lib/tenant";
import { isAdminUser } from "@/lib/admin";

export const runtime = "nodejs";

/**
 * Settings write. ADMINS ONLY — regular users can view settings but not change them.
 * (Defense-in-depth: the UI also disables the controls for non-admins.) The browser sends the
 * session cookie automatically; the write itself uses the service-role admin client.
 */
async function authorizedAdmin(): Promise<boolean> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

export async function POST(req: Request) {
  if (!(await authorizedAdmin())) {
    return NextResponse.json({ error: "Admins only — you don't have permission to change settings." }, { status: 403 });
  }

  let body: { key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { key, value } = body;
  if (typeof key !== "string" || key.length === 0) {
    return NextResponse.json({ error: "Missing or invalid key" }, { status: 400 });
  }

  const sb = createAdminClient();
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  // Validate the key exists up front (covers both reset and write paths).
  const def = await sb.from("setting_definitions").select("value_type").eq("key", key).maybeSingle();
  if (def.error) {
    console.error("settings: definition lookup failed", def.error);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
  if (!def.data) return NextResponse.json({ error: "Unknown setting" }, { status: 400 });

  // value === null => reset to default (delete the override row)
  if (value === null) {
    const del = await sb.from("tenant_settings").delete().eq("tenant_id", tenantId).eq("key", key);
    if (del.error) {
      console.error("settings: reset failed", del.error);
      return NextResponse.json({ error: "Reset failed" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, reset: true });
  }

  let coerced: any = value;
  const vt = def.data.value_type;
  if (vt === "boolean") coerced = Boolean(value);
  else if (vt === "enum") coerced = String(value);
  else if (vt === "url" || vt === "text" || vt === "longtext") {
    coerced = String(value ?? "").trim();
    if (!coerced) return NextResponse.json({ error: "Can't be empty" }, { status: 400 });
    if (vt === "longtext" && coerced.length > 1000) {
      return NextResponse.json({ error: "Message is too long (max 1000 characters)." }, { status: 400 });
    }
    if (vt === "url" && !/^https?:\/\/.+/i.test(coerced)) {
      return NextResponse.json({ error: "Must be a URL starting with http:// or https://" }, { status: 400 });
    }
  } else {
    coerced = Number(value);
    if (Number.isNaN(coerced)) return NextResponse.json({ error: "Must be a number" }, { status: 400 });
  }

  const up = await sb
    .from("tenant_settings")
    .upsert(
      { tenant_id: tenantId, key, value: coerced, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,key" }
    );
  // The DB validation trigger rejects out-of-range / wrong-type values.
  if (up.error) {
    console.error("settings: write failed", up.error);
    // Surface validation failures (min/max/enum) which are safe + useful; mask the rest.
    const msg = /below min|above max|must be|one of/i.test(up.error.message)
      ? up.error.message
      : "Save failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
