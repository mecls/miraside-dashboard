import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaGet } from "@/lib/meta";
import { getAdCreativeInfo, pageAccessToken } from "@/lib/meta-ads";
import { getPrimaryTenantId } from "@/lib/tenant";
import { derivePlacementGroups } from "@/lib/placements";

export const runtime = "nodejs";

/** Returns the current editable settings for a campaign or ad set, to pre-fill the Edit panel. */
export async function GET(req: Request) {
  const supa = await createServerSupabase();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const dbId = url.searchParams.get("dbId") ?? "";
  const level = url.searchParams.get("level") ?? "";
  if (!dbId || !["campaign", "adset", "ad"].includes(level)) {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const admin = createAdminClient();
  const table = level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads";
  const fbCol = level === "campaign" ? "fb_campaign_id" : level === "adset" ? "fb_adset_id" : "fb_ad_id";
  const row = await admin.from(table).select(`id, ${fbCol}`).eq("id", dbId).maybeSingle();
  if (row.error || !row.data) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const fbId = (row.data as any)[fbCol] as string;

  try {
    if (level === "campaign") {
      const c = await metaGet<any>(fbId, { fields: "daily_budget,objective,buying_type" });
      return NextResponse.json({
        ok: true,
        settings: {
          dailyBudgetEur: c.daily_budget ? Number(c.daily_budget) / 100 : null,
          objective: c.objective ?? null,
          buyingType: c.buying_type ?? null,
        },
      });
    }
    if (level === "ad") {
      const [ad, info] = await Promise.all([metaGet<any>(fbId, { fields: "name" }), getAdCreativeInfo(fbId)]);
      let formName: string | null = null;
      if (info.leadGenFormId) {
        try {
          const token = await pageAccessToken();
          const r = await fetch(`https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}/${info.leadGenFormId}?fields=name&access_token=${token}`);
          formName = (await r.json())?.name ?? null;
        } catch {}
      }
      const tenantId = await getPrimaryTenantId();
      const tpls = tenantId
        ? (await admin.from("lead_form_templates").select("id,name,meta_form_id").eq("tenant_id", tenantId).order("created_at", { ascending: false })).data ?? []
        : [];
      return NextResponse.json({
        ok: true,
        settings: {
          name: ad.name ?? "",
          message: info.message,
          headline: info.headline,
          cta: info.cta,
          autoCrop: info.autoCrop,
          imageHash: info.imageHash,
          currentForm: info.leadGenFormId ? { id: info.leadGenFormId, name: formName } : null,
          savedForms: tpls.filter((t: any) => t.meta_form_id).map((t: any) => ({ id: t.id, name: t.name })),
        },
      });
    }

    const a = await metaGet<any>(fbId, {
      fields: "dsa_beneficiary,targeting{age_min,age_max,publisher_platforms,facebook_positions,instagram_positions}",
    });
    const platforms: string[] = a.targeting?.publisher_platforms ?? [];
    return NextResponse.json({
      ok: true,
      settings: {
        ageMin: a.targeting?.age_min ?? 29,
        ageMax: a.targeting?.age_max ?? 65,
        advertiser: a.dsa_beneficiary ?? "Miguel Rolo",
        fb: platforms.length ? platforms.includes("facebook") : true,
        ig: platforms.length ? platforms.includes("instagram") : true,
        placements: derivePlacementGroups(a.targeting?.facebook_positions ?? [], a.targeting?.instagram_positions ?? []),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Couldn't load current settings." }, { status: 502 });
  }
}
