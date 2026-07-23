import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { isAdminUser } from "@/lib/admin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Presets are shared tenant-level config — admin-only, mirroring /api/settings.
  if (!isAdminUser(user)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }

  const name = String(b.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "Name the preset." }, { status: 400 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const countries = Array.isArray(b.countries) && b.countries.length ? b.countries.map(String) : ["PT"];
  const ageMin = Math.max(13, Math.min(65, Number(b.ageMin) || 29));
  const ageMax = Math.max(ageMin, Math.min(65, Number(b.ageMax) || 65));
  const genders = Array.isArray(b.genders) && b.genders.length ? b.genders.map(Number) : null;
  const platforms = Array.isArray(b.publisherPlatforms) && b.publisherPlatforms.length
    ? b.publisherPlatforms.map(String) : ["facebook", "instagram"];

  const extra = b.extra && typeof b.extra === "object" ? b.extra : null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ad_presets")
    .insert({
      tenant_id: tenantId, name, countries, age_min: ageMin, age_max: ageMax, genders,
      advantage_audience: !!b.advantageAudience, publisher_platforms: platforms,
      default_cta: String(b.defaultCta || "LEARN_MORE"),
      default_form_template_id: b.defaultFormTemplateId || null,
      extra,
    })
    .select("*")
    .maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false, error: error?.message ?? "Could not save preset." }, { status: 500 });

  const preset = {
    id: data.id, name: data.name, countries: data.countries, ageMin: data.age_min, ageMax: data.age_max,
    genders: data.genders, advantageAudience: data.advantage_audience, publisherPlatforms: data.publisher_platforms,
    defaultCta: data.default_cta, defaultFormTemplateId: data.default_form_template_id, extra: data.extra ?? null,
  };
  return NextResponse.json({ ok: true, preset });
}

/** Delete a saved preset (preset management). */
export async function DELETE(req: Request) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminUser(user)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "Missing preset id." }, { status: 400 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin.from("ad_presets").delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
