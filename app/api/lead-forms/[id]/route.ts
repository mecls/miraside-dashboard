import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

/** Load one saved form's full definition (questions + greeting + thank-you) so the builder can edit/duplicate it. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("lead_form_templates")
    .select("id, name, questions, greeting, thank_you, is_audit")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false, error: "Form not found." }, { status: 404 });

  return NextResponse.json({
    ok: true,
    form: {
      id: data.id,
      name: data.name,
      questions: data.questions ?? [],
      greeting: data.greeting ?? null,
      thankYou: data.thank_you ?? null,
      isAudit: data.is_audit === true,
    },
  });
}

/** Permanently delete a saved form from the library. Ads already launched keep their minted Meta form. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin.from("lead_form_templates").delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
