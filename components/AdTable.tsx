"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AdPerf } from "@/lib/queries";
import { eur, int, pct, ratio } from "@/lib/format";
import { recommend } from "@/lib/recommend";
import { cplTone, ctrTone, freqTone, TEXT_TONE } from "@/lib/tone";
import { Chip, FlagBadge, cn } from "./ui";
import { toast } from "./Toaster";
import { Sparkline } from "./charts/Sparkline";
import { StatusToggle } from "./StatusToggle";
import { EditableName } from "./EditableName";
import { RowActions } from "./RowActions";
import { AdThumb, AdLightbox } from "./AdLightbox";
import { adUrl } from "@/lib/adsmanager";

type SortKey = "name" | "spend" | "leads" | "cpl" | "ctr" | "cpm" | "frequency" | "spendSharePct";
type Dir = "asc" | "desc";

const COLS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Ad", align: "left" },
  { key: "spend", label: "Spend", align: "right" },
  { key: "leads", label: "Leads", align: "right" },
  { key: "cpl", label: "CPL", align: "right" },
  { key: "ctr", label: "CTR", align: "right" },
  { key: "cpm", label: "CPM", align: "right" },
  { key: "frequency", label: "Freq", align: "right" },
  { key: "spendSharePct", label: "Spend %", align: "right" },
];

function sortVal(a: AdPerf, key: SortKey): number | string | null {
  if (key === "name") return a.name.toLowerCase();
  return (a as any)[key] ?? null;
}

export function AdTable({
  ads,
  spendGate,
  targetCpl,
  windowDays,
  fbAccountId,
}: {
  ads: AdPerf[];
  spendGate: number;
  targetCpl: number;
  windowDays: number;
  fbAccountId: string;
}) {
  const [selId, setSelId] = useState<string | null>(null);
  // Derive the open ad from the live `ads` prop (not a frozen snapshot) so a rename/refresh flows through.
  const sel = selId != null ? ads.find((a) => a.id === selId) ?? null : null;
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [dir, setDir] = useState<Dir>("desc");

  // Bulk selection + bulk on/off (the user flips many ads at once; turning on confirms first).
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const isArchived = (s: string) => {
    const u = (s || "").toUpperCase();
    return u === "ARCHIVED" || u === "DELETED";
  };
  const selectable = ads.filter((a) => !isArchived(a.status));
  const allSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.id));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && !allSelected;
  }, [selected, allSelected]);

  // Drop ids that are gone/archived after a refresh so the toolbar count stays truthful.
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((id) => ads.some((a) => a.id === id && !["ARCHIVED", "DELETED"].includes((a.status || "").toUpperCase()))));
      return next.size === s.size ? s : next;
    });
  }, [ads]);

  function toggleRow(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((a) => a.id)));
  }

  async function bulkSet(action: "resume" | "pause") {
    if (busy) return;
    const targets = ads.filter((a) => selected.has(a.id) && !isArchived(a.status));
    // Only act on ads that actually need the change, so the count/confirm/toast are truthful.
    const ids = targets
      .filter((a) => (action === "resume" ? a.status.toUpperCase() !== "ACTIVE" : a.status.toUpperCase() === "ACTIVE"))
      .map((a) => a.id);
    const n = ids.length;
    if (n === 0) {
      if (targets.length > 0) toast(`Selected ad${targets.length === 1 ? "" : "s"} already ${action === "resume" ? "on" : "off"}`);
      return;
    }
    if (action === "resume" && !confirm(`Turn ON ${n} ad${n === 1 ? "" : "s"}? They will start delivering and SPENDING once their campaign and ad set are also on.`)) return;
    if (action === "pause" && !confirm(`Turn off ${n} ad${n === 1 ? "" : "s"}?`)) return;
    setBusy(true);
    const settled = await Promise.allSettled(
      ids.map(async (id) => {
        const res = await fetch("/api/ads/manage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dbId: id, level: "ad", action }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || "failed");
        return id;
      })
    );
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const failed = n - ok;
    setBusy(false);
    setSelected(new Set());
    toast(failed === 0 ? `${ok} ad${ok === 1 ? "" : "s"} turned ${action === "resume" ? "on" : "off"}` : `${ok} turned ${action === "resume" ? "on" : "off"} · ${failed} failed`);
    router.refresh();
  }

  function clickHeader(k: SortKey) {
    if (k === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setDir(k === "name" ? "asc" : "desc");
    }
  }

  const sorted = [...ads].sort((a, b) => {
    const av = sortVal(a, sortKey);
    const bv = sortVal(b, sortKey);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls always last
    if (bv == null) return -1;
    if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
    return dir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });

  return (
    <>
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm shadow-xs">
          <span className="font-medium text-neutral-200">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => bulkSet("resume")}
              disabled={busy}
              className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50"
            >
              Turn on
            </button>
            <button
              onClick={() => bulkSet("pause")}
              disabled={busy}
              className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 focus-visible:outline-none disabled:opacity-50"
            >
              Turn off
            </button>
            <button onClick={() => setSelected(new Set())} className="inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
              Clear
            </button>
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
        <table className="min-w-full text-sm">
          <thead className="border-b border-neutral-800 bg-panel">
            <tr>
              <th className="px-4 py-2.5 pl-5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">
                <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all ads" className="h-4 w-4 align-middle accent-emerald-500" />
              </th>
              <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">On</th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => clickHeader(c.key)}
                  className={cn(
                    "cursor-pointer select-none whitespace-nowrap px-4 py-2.5 font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500 hover:text-neutral-300",
                    c.align === "right" ? "text-right" : "text-left"
                  )}
                >
                  {c.label}
                  <span className="ml-1 text-neutral-600">{sortKey === c.key ? (dir === "asc" ? "▲" : "▼") : ""}</span>
                </th>
              ))}
              <th className="px-4 py-2.5 pr-5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Flags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.id} onClick={() => setSelId(a.id)} className={cn("group cursor-pointer border-b border-neutral-800 last:border-0 hover:bg-surface-200/50", selected.has(a.id) && "bg-neutral-900")}>
                <td className="px-4 py-2.5 pl-5 text-sm" onClick={(e) => e.stopPropagation()}>
                  {!isArchived(a.status) && (
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleRow(a.id)} aria-label={`Select ${a.name}`} className="h-4 w-4 accent-emerald-500" />
                  )}
                </td>
                <td className="px-4 py-2.5 text-sm"><StatusToggle dbId={a.id} level="ad" status={a.status} size="sm" /></td>
                <td className="px-4 py-2.5 text-sm align-top">
                  <div className="flex items-start gap-2">
                    <AdThumb thumb={a.thumb} full={a.imageUrl} name={a.name} />
                    <div className="min-w-0">
                      <div className="max-w-[220px] truncate font-medium text-neutral-100">{a.name}</div>
                      <div className="text-[11px] text-neutral-600">{a.status.toLowerCase()}</div>
                      <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <RowActions chartsHref={adUrl(fbAccountId, a.fbAdsetId, a.fbAdId)} dbId={a.id} level="ad" noun="ad" name={a.name} />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right text-sm tabular-nums text-neutral-200">{eur(a.spend)}</td>
                <td className="px-4 py-2.5 text-right text-sm tabular-nums text-neutral-200">{int(a.leads)}</td>
                <td className={cn("px-4 py-2.5 text-right text-sm tabular-nums", TEXT_TONE[cplTone(a.cpl, targetCpl, a.gated)])}>
                  {a.gated ? <span className="text-neutral-600">insufficient</span> : eur(a.cpl)}
                </td>
                <td className={cn("px-4 py-2.5 text-right text-sm tabular-nums", TEXT_TONE[ctrTone(a.ctr, 2)])}>{pct(a.ctr, 2)}</td>
                <td className="px-4 py-2.5 text-right text-sm tabular-nums text-neutral-400">{eur(a.cpm)}</td>
                <td className={cn("px-4 py-2.5 text-right text-sm tabular-nums", TEXT_TONE[freqTone(a.freqBand)])}>{ratio(a.frequency)}</td>
                <td className="px-4 py-2.5 text-right text-sm tabular-nums text-neutral-400">{pct(a.spendSharePct, 1)}</td>
                <td className="px-4 py-2.5 pr-5 text-sm">
                  <div className="flex flex-wrap gap-1">
                    {a.flags.slice(0, 2).map((f) => (
                      <FlagBadge key={f.id} flag={f} />
                    ))}
                    {a.flags.length > 2 && (
                      <Chip className="border-neutral-700 bg-neutral-500/10 text-neutral-400">+{a.flags.length - 2}</Chip>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sel && <AdDrawer ad={sel} onClose={() => setSelId(null)} spendGate={spendGate} targetCpl={targetCpl} windowDays={windowDays} />}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: keyof typeof TEXT_TONE }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-xs">
      <div className="mono-label">{label}</div>
      <div className={cn("mt-0.5 text-sm font-medium tabular-nums", tone ? TEXT_TONE[tone] : "text-neutral-100")}>{value}</div>
    </div>
  );
}

export function AdDrawer({
  ad,
  onClose,
  spendGate,
  targetCpl,
  windowDays,
}: {
  ad: AdPerf;
  onClose: () => void;
  spendGate: number;
  targetCpl: number;
  windowDays: number;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-neutral-800 bg-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-800 p-5">
          <div>
            <div className="text-neutral-50"><EditableName dbId={ad.id} level="ad" name={ad.name} linkClass="font-medium text-neutral-50" /></div>
            <div className="text-[11px] text-neutral-500">
              {ad.campaignName ? `${ad.campaignName} · ` : ""}
              {ad.status.toLowerCase()}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <StatusToggle dbId={ad.id} level="ad" status={ad.status} size="sm" />
              <span className="text-[11px] text-neutral-500">turn this ad on/off</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-500 hover:bg-surface-200 hover:text-neutral-100">
            ✕
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* The creative — click to view full-screen */}
          <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
            {ad.imageUrl ? (
              <button onClick={() => setZoom(true)} className="block w-full cursor-zoom-in" title="Click to view the ad">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ad.imageUrl} alt={ad.name} className="max-h-72 w-full object-contain" />
              </button>
            ) : (
              <div className="flex h-40 items-center justify-center text-sm text-neutral-600">no creative preview</div>
            )}
          </div>
          {zoom && ad.imageUrl && <AdLightbox url={ad.imageUrl} name={ad.name} onClose={() => setZoom(false)} />}

          {/* Recommendation */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs">
            <div className="mono-label">Recommendation</div>
            <p className="mt-1.5 text-sm text-neutral-200">{recommend(ad, spendGate, targetCpl)}</p>
          </div>

          {ad.flags.length > 0 && (
            <div>
              <div className="mono-label">Flags</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ad.flags.map((f) => (
                  <FlagBadge key={f.id} flag={f} />
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mono-label">Daily spend</div>
            <div className="mt-2">
              <Sparkline data={ad.daily} dataKey="spend" />
            </div>
          </div>

          <div>
            <div className="mono-label">Diagnostics</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Stat label="CTR (all)" value={pct(ad.ctr, 2)} tone={ctrTone(ad.ctr, 2)} />
              <Stat label="CTR (link)" value={pct(ad.linkCtr, 2)} tone={ctrTone(ad.linkCtr, 1)} />
              <Stat label="CPC (link)" value={eur(ad.cpc)} />
              <Stat label="CPM" value={eur(ad.cpm)} />
              <Stat label="Link clicks" value={int(ad.linkClicks)} />
              <Stat label="LP views" value={int(ad.lpViews)} />
              <Stat label="Spend share" value={pct(ad.spendSharePct, 1)} />
              <Stat
                label="Cost / lead"
                value={ad.gated ? "insufficient" : eur(ad.costPerResult)}
                tone={cplTone(ad.cpl, targetCpl, ad.gated)}
              />
            </div>
          </div>

          <div>
            <div className="mono-label">Reach &amp; health</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Stat label={`Reach (${windowDays}d)`} value={int(ad.reach)} />
              <Stat label={`Frequency (${windowDays}d)`} value={ratio(ad.frequency)} tone={freqTone(ad.freqBand)} />
              <div className="col-span-2 rounded-lg border border-dashed border-neutral-800 p-3 text-xs text-neutral-600">
                EMQ &amp; audience segments activate with the Events-Manager pull.
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
