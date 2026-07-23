import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { getUrlSettings } from "@/lib/settings";
import { listCampaignsWithAdSets, listPageLeadForms } from "@/lib/meta-ads";
import { PageHeader } from "@/components/ui";
import { AdLauncher } from "@/components/launcher/AdLauncher";
import type { LaunchRow, AdSetupData, ExistingAd, Preset } from "@/components/launcher/types";

export const dynamic = "force-dynamic";

// LaunchHistory polls this page every 4s while a launch is in flight. Cache the live Graph read so those
// refreshes don't fire 2 Meta calls every 4s and burn the Development-tier rate budget the launch needs (C17).
const getCampaignTree = unstable_cache(async () => listCampaignsWithAdSets().catch(() => [] as any[]), ["launch-campaign-tree"], {
  revalidate: 60,
});

// The Page's live instant forms, so they can be picked and used AS-IS (no new form minted on launch).
// Same caching reason as the campaign tree: History polls this page every 4s.
const getPageForms = unstable_cache(async () => listPageLeadForms({ activeOnly: true }).catch(() => [] as any[]), ["launch-page-lead-forms"], {
  revalidate: 60,
});

export default async function Page() {
  const admin = createAdminClient();
  const tenantId = await getPrimaryTenantId();

  const [launchesRes, leadFormsRes, adsRes, presetsRes, campaigns, pageForms] = await Promise.all([
    tenantId
      ? admin
          .from("ad_launches")
          .select("id, name, status, format, ad_count, thumb_urls, created_at, launched_at, last_error, total_ads, pending, live_status")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as any[] }),
    tenantId
      ? admin.from("lead_form_templates").select("id, name, meta_form_id").eq("tenant_id", tenantId).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as any[] }),
    tenantId
      ? admin
          .from("ads")
          .select("id, name, status, fb_ad_id, creative_thumb_url")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as any[] }),
    tenantId
      ? admin.from("ad_presets").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as any[] }),
    getCampaignTree(),
    getPageForms(),
  ]);

  const { defaultWebsiteUrl } = await getUrlSettings(admin, tenantId);

  const launches: LaunchRow[] = (launchesRes.data ?? []).map((l: any) => ({
    id: l.id,
    name: l.name,
    status: l.status,
    format: l.format,
    adCount: l.ad_count ?? 0,
    // Only the 3 the row's ThumbStack renders — the popup fetches the full set on demand. Shipping all 16
    // per launch × 50 launches would put megabytes of base64 in this page's payload (it polls every 4s).
    thumbUrls: (l.thumb_urls ?? []).slice(0, 3),
    createdAt: l.created_at,
    launchedAt: l.launched_at,
    lastError: l.last_error ?? null,
    liveStatus: l.live_status ?? null,
    totalAds: l.total_ads ?? null,
    nextBatchAt: (l.pending && typeof l.pending === "object" ? l.pending.nextAt : null) ?? null,
  }));

  const existingAds: ExistingAd[] = (adsRes.data ?? [])
    .filter((a: any) => a.fb_ad_id)
    .map((a: any) => ({ id: a.id, fbAdId: a.fb_ad_id, name: a.name ?? "Untitled ad", status: a.status ?? "", thumb: a.creative_thumb_url ?? null }));

  const presets: Preset[] = (presetsRes.data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    countries: p.countries ?? ["PT"],
    ageMin: p.age_min ?? 29,
    ageMax: p.age_max ?? 65,
    genders: p.genders ?? null,
    advantageAudience: !!p.advantage_audience,
    publisherPlatforms: p.publisher_platforms ?? ["facebook", "instagram"],
    defaultCta: p.default_cta ?? "LEARN_MORE",
    defaultFormTemplateId: p.default_form_template_id ?? null,
    extra: p.extra ?? null,
  }));

  const pageId = process.env.META_PAGE_ID;
  const data: AdSetupData = {
    pages: pageId ? [{ id: pageId, name: "Miraside AI" }] : [],
    instagram: [],
    whatsapp: [],
    adSetTree: (campaigns ?? []).map((c: any) => ({
      campaignId: c.id,
      campaignName: c.name,
      adSets: (c.adsets ?? []).map((a: any) => ({ id: a.id, name: a.name, active: (a.status || "").toUpperCase() === "ACTIVE" })),
    })),
    // Two kinds of pick, both valid:
    //  - a saved template (uuid) → editable; its Meta form is minted on first launch and reused after.
    //  - "meta:<id>" → a form that already exists on the Page, used AS-IS (nothing minted, leads pool into it).
    // Skip Page forms a template already owns, so the same form never appears twice.
    leadForms: [
      ...(leadFormsRes.data ?? []).map((f: any) => ({ id: f.id, name: f.name })),
      ...(() => {
        const owned = new Set((leadFormsRes.data ?? []).map((f: any) => f.meta_form_id).filter(Boolean));
        return (pageForms ?? []).filter((f: any) => !owned.has(f.id)).map((f: any) => ({ id: `meta:${f.id}`, name: f.name }));
      })(),
    ],
    presets,
    defaultWebsiteUrl,
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader title="Ads Launcher" />
      <AdLauncher launches={launches} data={data} existingAds={existingAds} />
    </div>
  );
}
