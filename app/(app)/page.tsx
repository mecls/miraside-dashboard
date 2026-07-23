import { Suspense, type ReactNode } from "react";
import { getDashboard } from "@/lib/queries";
import { eur, int, pct } from "@/lib/format";
import { cplTone, ctrTone } from "@/lib/tone";
import { PageHeader, SectionLabel, Kpi } from "@/components/ui";
import { RangePicker } from "@/components/RangePicker";
import { LeadsLine } from "@/components/charts/LeadsLine";
import { SpendBar } from "@/components/charts/SpendBar";
import { SourceDonut } from "@/components/charts/SourceDonut";

export const dynamic = "force-dynamic";

/** "42m" / "3.4h" / "1.2d" — speed-to-lead reads as a duration, not a timestamp. */
function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = ms / 3_600_000;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// Leads + Booked used to open this funnel — dropped 2026-07-22: the Leads/Meetings source donuts above
// already tell that story with a per-source split.
const FUNNEL_STAGES = [
  { key: "held_1", label: "1st Held" },
  { key: "held_2", label: "2nd Held" },
  { key: "va", label: "Verbal" },
  { key: "won", label: "Won" },
];

/** Shared card shell for the source-mix grid — same Supabase anatomy as the chart cards above. */
function SourceCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
      <div className="border-b border-neutral-800 px-4 py-3">
        <h2 className="mono-title">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}


export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const d = await getDashboard({ from: sp.from, to: sp.to });

  return (
    <div className="mx-auto max-w-6xl px-6 pb-10">
      <PageHeader
        title="Overview"
        right={
          <Suspense fallback={null}>
            <RangePicker today={d.accountToday} />
          </Suspense>
        }
      />

      {/* Tier-1 KPI strip — every ads-only metric lives HERE as a box (Miguel, 2026-07-23), including
          CAC and ROAS; the source grid below keeps only the by-source donuts. */}
      <section className="mt-6">
        <SectionLabel>This period</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Kpi label="Ad Spend" value={eur(d.totals.spend)} />
          <Kpi label="Leads" value={int(d.totals.leads)} sub="Meta-reported, this range" />{/* distinct from the Leads page's all-time captured records (C44) */}
          <Kpi
            label="Cost / Lead"
            value={d.totals.cpl == null ? "—" : eur(d.totals.cpl)}
            sub={d.totals.cpl == null ? `needs ≥${d.minResults} leads` : "account-level"}
            tone={cplTone(d.totals.cpl, d.targetCpl, d.totals.cpl == null)}
          />
          <Kpi
            label="Conversion Rate"
            value={d.totals.convRate == null ? "—" : pct(d.totals.convRate)}
            sub="leads ÷ link clicks"
          />
          <Kpi label="CTR" value={pct(d.totals.ctr, 2)} tone={ctrTone(d.totals.ctr, 2)} />
          <Kpi label="CPM" value={eur(d.totals.cpm)} />
          <Kpi
            label="CAC"
            value={d.sales.cac == null ? eur(0) : eur(d.sales.cac)}
            sub={d.sales.cac == null ? "ad spend ÷ closed clients" : `ad spend ÷ ${d.sales.closedAds} closed client${d.sales.closedAds === 1 ? "" : "s"}`}
            muted={d.sales.cac == null}
          />
          <Kpi
            label="ROAS"
            value={d.sales.roas == null ? "0.00×" : `${d.sales.roas.toFixed(2)}×`}
            sub={d.sales.roas == null ? "ad revenue ÷ ad spend" : `${eur(d.sales.revenueAds)} ÷ ${eur(d.totals.spend)}`}
            muted={d.sales.roas == null}
          />
          {/* All-channels pair, folded into the same grid (Miguel, 2026-07-23). The "Leads" box above
              stays Meta-reported — this one is the CRM's own capture count across every source. */}
          <Kpi
            label="Leads · All Channels"
            value={int(d.allChannelLeads.total)}
            sub={`${d.allChannelLeads.ads} ads · ${d.allChannelLeads.other} other sources`}
          />
          <Kpi
            label="Speed to Lead"
            value={d.speedToLead.medianMs == null ? "—" : fmtDuration(d.speedToLead.medianMs)}
            sub={d.speedToLead.medianMs == null ? "no called ad leads in range" : `ad lead → first call · median of ${d.speedToLead.sampled}`}
            tone={
              d.speedToLead.medianMs == null
                ? undefined
                : d.speedToLead.medianMs <= 15 * 60_000
                  ? "good"
                  : d.speedToLead.medianMs > 4 * 3_600_000
                    ? "bad"
                    : undefined
            }
          />
        </div>
      </section>

      {/* Charts — Supabase card anatomy: bordered mono-title header strip, content below. */}
      <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
          <div className="border-b border-neutral-800 px-4 py-3">
            <h2 className="mono-title">Weekly leads</h2>
          </div>
          <div className="p-4">
            {d.weekly.length ? (
              <LeadsLine data={d.weekly.map((w) => ({ week: w.week, leads: w.leads, partial: w.partial }))} />
            ) : (
              <p className="py-16 text-center text-sm text-neutral-600">No data in range.</p>
            )}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
          <div className="border-b border-neutral-800 px-4 py-3">
            <h2 className="mono-title">Daily spend</h2>
          </div>
          <div className="p-4">
            {d.daily.length ? (
              <SpendBar data={d.daily.map((x) => ({ date: x.date, spend: x.spend, partial: x.partial }))} />
            ) : (
              <p className="py-16 text-center text-sm text-neutral-600">No data in range.</p>
            )}
          </div>
        </div>
      </section>

      {/* Source mix — where leads, meetings, closes and revenue come from (all channels, this range).
          CAC + ROAS are ads-only NUMBERS, not breakdowns — they live in the KPI strip up top. */}
      <section className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SourceCard title="Leads by source">
          <SourceDonut data={d.bySource.leads} empty="No leads in range." />
        </SourceCard>
        <SourceCard title="Meetings by source">
          <SourceDonut data={d.bySource.meetings} empty="No meetings in range." />
        </SourceCard>
        <SourceCard title="Closed by source">
          <SourceDonut data={d.bySource.closed} empty="No closed deals in range." />
        </SourceCard>
        <SourceCard title="Revenue by source">
          <SourceDonut data={d.bySource.revenue} empty="No revenue in range." format="eur" />
        </SourceCard>
      </section>

      {/* Funnel */}
      <section className="mt-8">
        <SectionLabel>Funnel</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FUNNEL_STAGES.map((s) => {
            // Won is live (closes recorded on meetings / GHL opportunities); the middle stages wait
            // for their own tracking.
            const closedTotal = d.bySource.closed.reduce((n, x) => n + x.count, 0);
            const isReal = s.key === "won";
            return (
              <div
                key={s.key}
                className={`rounded-lg border p-4 ${isReal ? "border-neutral-800 bg-neutral-900 shadow-xs" : "border-dashed border-neutral-800"}`}
              >
                <div className={`text-2xl font-medium tabular-nums ${isReal ? "text-neutral-50" : "text-neutral-600"}`}>
                  {isReal ? int(closedTotal) : "—"}
                </div>
                <div className="mono-label mt-1">{s.label}</div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
