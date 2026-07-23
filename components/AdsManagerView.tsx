"use client";

import { useState } from "react";
import type { AdPerf, AdSetSummary, CampaignSummary } from "@/lib/queries";
import { eur, int, pct } from "@/lib/format";
import { cplTone, ctrTone } from "@/lib/tone";
import { StatusToggle } from "./StatusToggle";
import { EditableName } from "./EditableName";
import { RowActions } from "./RowActions";
import { AdTable } from "./AdTable";
import { campaignUrl, adsetUrl } from "@/lib/adsmanager";
import { Kpi, SectionLabel, cn } from "./ui";

const th = "px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500";
const tdNum = "px-4 py-2.5 text-right text-sm tabular-nums text-neutral-200";

function Delivery({ status }: { status: string }) {
  const s = (status || "").toUpperCase();
  const on = s === "ACTIVE";
  const archived = s === "ARCHIVED" || s === "DELETED";
  const color = on ? "bg-emerald-400" : archived ? "bg-neutral-600" : "bg-neutral-500";
  const lbl = on ? "Active" : archived ? "Archived" : "Off";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      {lbl}
    </span>
  );
}

// Inlined equivalent of lib/queries computeTotals (kept client-safe — queries.ts is server-only).
function localTotals(list: AdPerf[], minResults: number) {
  const t = list.reduce(
    (s, a) => {
      s.spend += a.spend; s.impressions += a.impressions; s.clicks += a.clicks; s.linkClicks += a.linkClicks; s.leads += a.leads;
      return s;
    },
    { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0 }
  );
  const enough = t.leads >= minResults;
  return {
    ...t,
    cpl: enough && t.leads > 0 ? t.spend / t.leads : null,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
  };
}

type Tab = "campaigns" | "adsets" | "ads";

export function AdsManagerView({
  campaigns,
  adsets,
  ads,
  spendGate,
  targetCpl,
  minResults,
  windowDays,
  fbAccountId,
}: {
  campaigns: CampaignSummary[];
  adsets: AdSetSummary[];
  ads: AdPerf[];
  spendGate: number;
  targetCpl: number;
  minResults: number;
  windowDays: number;
  fbAccountId: string;
}) {
  const [tab, setTab] = useState<Tab>("campaigns");
  const [selCampaign, setSelCampaign] = useState<string | null>(null);
  const [selAdset, setSelAdset] = useState<string | null>(null);

  const campaign = campaigns.find((c) => c.id === selCampaign) ?? null;
  const adset = adsets.find((s) => s.id === selAdset) ?? null;
  const shownAdsets = selCampaign ? adsets.filter((s) => s.campaignId === selCampaign) : [];
  const shownAds = selAdset ? ads.filter((a) => a.adsetId === selAdset) : [];

  // Summary + best-creatives for the ad set currently being viewed (restored from the old page).
  const totals = localTotals(shownAds, minResults);
  const topCreatives = [...shownAds]
    .filter((a) => !a.gated && a.costPerResult != null)
    .sort((a, b) => a.costPerResult! - b.costPerResult!)
    .slice(0, 5);

  const TabBtn = ({ id, label, count, disabled }: { id: Tab; label: string; count?: number; disabled?: boolean }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => !disabled && setTab(id)}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        tab === id ? "bg-surface-200 text-neutral-100" : disabled ? "cursor-not-allowed text-neutral-700" : "text-neutral-400 hover:text-neutral-100"
      )}
    >
      <span className="max-w-[220px] truncate">{label}</span>
      {count != null && (
        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] tabular-nums", tab === id ? "bg-neutral-700 text-neutral-200" : "bg-surface-200 text-neutral-500")}>{count}</span>
      )}
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-1.5">
        <TabBtn id="campaigns" label="Campaigns" count={campaigns.length} />
        <span className="px-1 text-neutral-700">›</span>
        <TabBtn id="adsets" label={campaign ? `Ad sets · ${campaign.name}` : "Ad sets"} count={selCampaign ? shownAdsets.length : undefined} disabled={!selCampaign} />
        <span className="px-1 text-neutral-700">›</span>
        <TabBtn id="ads" label={adset ? `Ads · ${adset.name}` : "Ads"} count={selAdset ? shownAds.length : undefined} disabled={!selAdset} />
      </div>

      {/* CAMPAIGNS + AD SETS: lightweight roll-up tables (drill in via the name) */}
      {(tab === "campaigns" || tab === "adsets") && (
        <div className="mt-3 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
          <table className="min-w-full text-sm">
            <thead className="border-b border-neutral-800 bg-panel">
              <tr>
                <th className={cn(th, "pl-5")}>On / Off</th>
                <th className={th}>{tab === "campaigns" ? "Campaign" : "Ad set"}</th>
                <th className={th}>Delivery</th>
                <th className={cn(th, "text-right")}>Spend</th>
                <th className={cn(th, "text-right")}>Leads</th>
                <th className={cn(th, "text-right")}>CPL</th>
                <th className={cn(th, "text-right")}>Impressions</th>
                <th className={cn(th, "text-right pr-5")} />
              </tr>
            </thead>
            <tbody>
              {tab === "campaigns" &&
                campaigns.map((c) => {
                  const cpl = c.leads > 0 ? c.spend / c.leads : null;
                  return (
                    <tr key={c.id} className="group border-b border-neutral-800 last:border-0 hover:bg-surface-200/50">
                      <td className="px-4 py-2.5 pl-5 text-sm"><StatusToggle dbId={c.id} level="campaign" status={c.status} size="sm" /></td>
                      <td className="px-4 py-2.5 text-sm"><EditableName dbId={c.id} level="campaign" name={c.name} onClick={() => { setSelCampaign(c.id); setSelAdset(null); setTab("adsets"); }} /></td>
                      <td className="px-4 py-2.5 text-sm"><Delivery status={c.status} /></td>
                      <td className={tdNum}>{eur(c.spend)}</td>
                      <td className={tdNum}>{int(c.leads)}</td>
                      <td className={tdNum}>{cpl != null ? eur(cpl) : "—"}</td>
                      <td className={tdNum}>{int(c.impressions)}</td>
                      <td className="px-4 py-2.5 pr-5 text-right text-sm"><span className="opacity-0 transition-opacity group-hover:opacity-100"><RowActions chartsHref={campaignUrl(fbAccountId, c.fbId)} dbId={c.id} level="campaign" noun="campaign" name={c.name} /></span></td>
                    </tr>
                  );
                })}
              {tab === "adsets" &&
                (shownAdsets.length ? (
                  shownAdsets.map((s) => (
                    <tr key={s.id} className="group border-b border-neutral-800 last:border-0 hover:bg-surface-200/50">
                      <td className="px-4 py-2.5 pl-5 text-sm"><StatusToggle dbId={s.id} level="adset" status={s.status} size="sm" /></td>
                      <td className="px-4 py-2.5 text-sm"><EditableName dbId={s.id} level="adset" name={s.name} onClick={() => { setSelAdset(s.id); setTab("ads"); }} /></td>
                      <td className="px-4 py-2.5 text-sm"><Delivery status={s.status} /></td>
                      <td className={tdNum}>{eur(s.spend)}</td>
                      <td className={tdNum}>{int(s.leads)}</td>
                      <td className={tdNum}>{s.cpl != null ? eur(s.cpl) : "—"}</td>
                      <td className={tdNum}>{int(s.impressions)}</td>
                      <td className="px-4 py-2.5 pr-5 text-right text-sm"><span className="opacity-0 transition-opacity group-hover:opacity-100"><RowActions chartsHref={adsetUrl(fbAccountId, s.fbCampaignId, s.fbId)} dbId={s.id} level="adset" noun="ad set" name={s.name} /></span></td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-neutral-600">No ad sets in this campaign.</td></tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ADS: KPI strip + best creatives + the full table we built (all metrics, flags, drawer) */}
      {tab === "ads" && (
        shownAds.length ? (
          <>
            <section className="mt-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Kpi label="Spend" value={eur(totals.spend)} />
                <Kpi label="Leads" value={int(totals.leads)} />
                <Kpi
                  label="Cost / Lead"
                  value={totals.cpl == null ? "—" : eur(totals.cpl)}
                  sub={totals.cpl == null ? `needs ≥${minResults} leads` : undefined}
                  tone={cplTone(totals.cpl, targetCpl, totals.cpl == null)}
                />
                <Kpi label="CTR" value={pct(totals.ctr, 2)} tone={ctrTone(totals.ctr, 2)} />
                <Kpi label="CPM" value={eur(totals.cpm)} />
                <Kpi label="Ads" value={int(shownAds.length)} />
              </div>
            </section>

            <section className="mt-8">
              <SectionLabel>Best creatives (cost-per-result)</SectionLabel>
              {topCreatives.length ? (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {topCreatives.map((a, i) => (
                    <div key={a.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs">
                      <div className="mono-label">#{i + 1}</div>
                      <div className="mt-1 truncate text-sm font-medium text-neutral-100">{a.name}</div>
                      <div className="mt-2 text-lg font-medium tabular-nums text-emerald-400">{eur(a.costPerResult)}</div>
                      <div className="mt-1 text-xs text-neutral-500">CTR {pct(a.ctr, 2)} · CPC {eur(a.cpc)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 rounded-lg border border-dashed border-neutral-800 p-4 text-sm text-neutral-600">
                  No ad here has cleared the {eur(spendGate, 0)} spend gate yet.
                </p>
              )}
            </section>

            <section className="mt-8">
              <SectionLabel>Ads</SectionLabel>
              <div className="mt-3">
                <AdTable ads={shownAds} spendGate={spendGate} targetCpl={targetCpl} windowDays={windowDays} fbAccountId={fbAccountId} />
              </div>
              <p className="mt-3 text-xs text-neutral-600">
                <span className="text-emerald-400">green</span> = on/above target ·{" "}
                <span className="text-amber-400">amber</span> = watch ·{" "}
                <span className="text-rose-400">red</span> = off-target. CPL is withheld until an ad clears the {eur(spendGate, 0)} spend gate.
              </p>
            </section>
          </>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-600">No ads in this ad set.</p>
        )
      )}

    </div>
  );
}
