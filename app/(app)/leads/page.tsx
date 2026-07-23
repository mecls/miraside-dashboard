import { PageHeader } from "@/components/ui";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { fetchLeadViews, fetchLeadsSyncedAt } from "@/lib/leads-data";
import { ghlConfigured } from "@/lib/ghl";
import { isAdminUser } from "@/lib/admin";
import { leadsContentMaxWidth } from "@/lib/leads-layout";
import { LeadsView } from "@/components/leads/LeadsView";
import { getSettingValues } from "@/lib/settings";
import { WA_TEMPLATE_KEYS } from "@/lib/whatsapp-templates";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  const tenantId = await getPrimaryTenantId();
  const admin = createAdminClient();
  const leads = tenantId ? await fetchLeadViews(admin, tenantId) : [];
  const leadsSyncedAt = tenantId ? await fetchLeadsSyncedAt(admin, tenantId) : null;
  // WhatsApp message templates (Settings overrides on top of the built-in defaults). Read here so the
  // Leads tab can pre-fill the right message without a client round-trip; a failure just falls back to
  // the defaults baked into lib/whatsapp-templates.
  let waTemplates: Record<string, unknown> = {};
  try {
    waTemplates = await getSettingValues(WA_TEMPLATE_KEYS, admin, tenantId);
  } catch {
    /* defaults apply */
  }
  // view + filters are read client-side from the URL (useSearchParams); only the search box is seeded here.
  const { q } = await searchParams;

  // All-time spend per fb_ad_id for the Ad-quality scoreboard (Spend / CPL / Cost-per-qualified).
  // fb_insights_daily keys by the INTERNAL ads.id — map through the ads table to Meta's fb_ad_id.
  // A partial sum silently understates CPL/CPQ, which is worse than no number — any read error
  // clears the rollup entirely so the scoreboard shows "—" instead of wrong euros.
  let spendByAd: Record<string, number> = {};
  if (tenantId) {
    try {
      const idToFb = new Map<string, string>();
      for (let start = 0; ; start += 1000) {
        const { data: adRows, error: adErr } = await admin
          .from("ads")
          .select("id, fb_ad_id")
          .eq("tenant_id", tenantId)
          .order("id")
          .range(start, start + 999);
        if (adErr) throw new Error(adErr.message);
        for (const a of adRows ?? []) idToFb.set(a.id as string, a.fb_ad_id as string);
        if (!adRows || adRows.length < 1000) break;
      }
      for (let start = 0; ; start += 1000) {
        const { data: ins, error: insErr } = await admin
          .from("fb_insights_daily")
          .select("ad_id, spend")
          .eq("tenant_id", tenantId)
          .order("id")
          .range(start, start + 999);
        if (insErr) throw new Error(insErr.message);
        for (const r of ins ?? []) {
          const fb = idToFb.get(r.ad_id as string);
          if (fb) spendByAd[fb] = (spendByAd[fb] ?? 0) + Number(r.spend ?? 0);
        }
        if (!ins || ins.length < 1000) break;
      }
    } catch (e) {
      console.error("spend rollup failed — scoreboard shows no spend this render:", e instanceof Error ? e.message : e);
      spendByAd = {};
    }
  }

  // Cap the whole page (header + cards + table) at the table's ideal width so nothing balloons on a
  // wide monitor — the Lead column stays a sane width and no column overflows. Below this width it
  // shrinks/scrolls normally. Depends on whether any lead has an audit link (widens the Actions col).
  const hasAudit = leads.some((l) => !!l.auditUrl);

  return (
    // px-3 on a phone: 24px of side padding out of a 390px screen is 12% of the width spent on nothing.
    <div className="mx-auto w-full px-3 pb-10 sm:px-6" style={{ maxWidth: leadsContentMaxWidth(hasAudit) }}>
      <PageHeader title="Leads" />
      <div className="mt-4 md:mt-6">
        <LeadsView leads={leads} ghlConfigured={ghlConfigured()} canDelete={isAdminUser(user)} spendByAd={spendByAd} initialQ={q} waTemplates={waTemplates} syncedAt={leadsSyncedAt} />
      </div>
    </div>
  );
}
