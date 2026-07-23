"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EditPanel } from "./EditPanel";
import { AdEditPanel } from "./AdEditPanel";
import { toast } from "./Toaster";

/**
 * Per-row actions for the Ads-Manager-style tables:
 *  - Charts: opens the object's performance view in the real Facebook Ads Manager (new tab).
 *  - Edit: campaign budget / ad-set age·advertiser·platforms, applied on Publish (campaign + ad set).
 *  - Duplicate: Meta-native copy (campaign→ad sets+ads, ad set→ads, ad→ad), always created PAUSED.
 */
export function RowActions({
  chartsHref,
  dbId,
  level,
  noun,
  name,
}: {
  chartsHref: string;
  dbId: string;
  level: "campaign" | "adset" | "ad";
  noun: string;
  name: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function duplicate(e: React.MouseEvent) {
    e.stopPropagation();
    const msg =
      level === "ad"
        ? "Duplicate this ad as a new PAUSED ad in the same ad set?"
        : `Duplicate this ${noun} and everything inside it? The copy is created PAUSED.`;
    if (!confirm(msg)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/ads/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbId, level, action: "duplicate" }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error ?? "Duplicate failed.");
      else { toast(`Duplicated ${noun} (paused)`); router.refresh(); } // the synced copy now shows up
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  const btn =
    "inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none disabled:opacity-50";

  return (
    <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <a href={chartsHref} target="_blank" rel="noopener noreferrer" title="Open in Facebook Ads Manager" className={btn}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        Charts
      </a>
      <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Edit" className={btn}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        Edit
      </button>
      <button type="button" onClick={duplicate} disabled={busy} title="Duplicate (paused)" className={btn}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        {busy ? "…" : "Duplicate"}
      </button>
      {err && <span className="text-[11px] text-rose-400">{err}</span>}
      {editing && (level === "ad"
        ? <AdEditPanel dbId={dbId} name={name} onClose={() => setEditing(false)} />
        : <EditPanel dbId={dbId} level={level as "campaign" | "adset"} name={name} onClose={() => setEditing(false)} />)}
    </span>
  );
}
