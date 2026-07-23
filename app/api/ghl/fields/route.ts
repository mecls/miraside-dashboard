import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { listGhlFields } from "@/lib/ghl-write";
import { fieldFingerprint } from "@/lib/fingerprint";

export const runtime = "nodejs";

/**
 * The GHL custom fields a form's questions can map to, plus any operator pins — so the launcher's form
 * builder can show, BEFORE you launch, whether each question lands in an existing field or makes a new one.
 * Deciding this here (with a human looking) beats discovering it in a webhook at 5am, where a wrong guess
 * silently drops the lead.
 */
export async function GET() {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  try {
    const fields = (await listGhlFields()).map((f) => ({ ...f, fingerprint: fieldFingerprint(f.name) }));
    const { data: pins } = await createAdminClient()
      .from("ghl_field_pins")
      .select("fingerprint, ghl_field_id")
      .eq("tenant_id", tenantId);
    return NextResponse.json({ ok: true, fields, pins: pins ?? [] });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Couldn't load GHL fields." }, { status: 502 });
  }
}

/** Pin a question (by fingerprint) to an existing GHL field — or clear the pin with ghlFieldId: null. */
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }

  const label = String(b?.label ?? "").trim();
  const fingerprint = fieldFingerprint(label);
  if (!fingerprint) return NextResponse.json({ ok: false, error: "Nothing to pin." }, { status: 400 });

  const admin = createAdminClient();
  const ghlFieldId = b?.ghlFieldId ? String(b.ghlFieldId) : null;
  if (!ghlFieldId) {
    await admin.from("ghl_field_pins").delete().eq("tenant_id", tenantId).eq("fingerprint", fingerprint);
    return NextResponse.json({ ok: true, cleared: true });
  }

  const { error } = await admin
    .from("ghl_field_pins")
    .upsert({ tenant_id: tenantId, fingerprint, ghl_field_id: ghlFieldId, label }, { onConflict: "tenant_id,fingerprint" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, fingerprint });
}
