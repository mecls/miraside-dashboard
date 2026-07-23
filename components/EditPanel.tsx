"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PLACEMENT_GROUPS, anyGroupOn, type PlacementGroups } from "@/lib/placements";
import { toast } from "./Toaster";
import { AppSelect } from "./AppSelect";

const label = "mono-label block mb-1";
const input = "mt-1 w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20 h-[34px]";

const ADVERTISERS = ["Miguel Rolo", "Miraside AI"];

/** Edit + Publish modal for a campaign (budget) or ad set (age / advertiser / platforms). */
export function EditPanel({ dbId, level, name, onClose }: { dbId: string; level: "campaign" | "adset"; name: string; onClose: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // campaign
  const [dailyBudgetEur, setDailyBudgetEur] = useState("");
  // ad set
  const [ageMin, setAgeMin] = useState(29);
  const [ageMax, setAgeMax] = useState(65);
  const [advertiser, setAdvertiser] = useState("Miguel Rolo");
  const [fb, setFb] = useState(true);
  const [ig, setIg] = useState(true);
  const [placements, setPlacements] = useState<PlacementGroups>({ feeds: true, stories: true, reels: true, instream: true });
  const [origPlacements, setOrigPlacements] = useState<PlacementGroups>({ feeds: true, stories: true, reels: true, instream: true });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/ads/settings?dbId=${encodeURIComponent(dbId)}&level=${level}`);
        const j = await res.json();
        if (!alive) return;
        if (!res.ok || !j.ok) setErr(j.error ?? "Couldn't load current settings.");
        else if (level === "campaign") {
          setDailyBudgetEur(j.settings.dailyBudgetEur != null ? String(j.settings.dailyBudgetEur) : "");
        } else {
          setAgeMin(j.settings.ageMin ?? 29);
          setAgeMax(j.settings.ageMax ?? 65);
          setAdvertiser(j.settings.advertiser || "Miguel Rolo");
          setFb(j.settings.fb !== false);
          setIg(j.settings.ig !== false);
          if (j.settings.placements) { setPlacements(j.settings.placements); setOrigPlacements(j.settings.placements); }
        }
      } catch { if (alive) setErr("Couldn't load current settings."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [dbId, level]);

  async function publish() {
    setErr(null);
    // Only send placements if the user actually changed them — otherwise the ad set's current
    // placements (incl. ones outside our 4 groups) are preserved untouched.
    const placementsChanged = JSON.stringify(placements) !== JSON.stringify(origPlacements);
    if (level === "campaign" && !(Number(dailyBudgetEur) >= 1)) { setErr("Daily budget must be at least €1."); return; }
    if (level === "adset" && !fb && !ig) { setErr("Pick at least one platform."); return; }
    if (level === "adset" && placementsChanged && !anyGroupOn(placements)) { setErr("Pick at least one placement."); return; }
    setBusy(true);
    try {
      const body = level === "campaign"
        ? { dbId, level, action: "budget", dailyEur: Number(dailyBudgetEur) }
        : { dbId, level, action: "edit_adset", ageMin: Number(ageMin), ageMax: Number(ageMax), advertiser, fb, ig, placements: placementsChanged ? placements : undefined };
      const res = await fetch("/api/ads/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error ?? "Publish failed.");
      else { toast(level === "campaign" ? "Campaign updated" : "Ad set updated"); router.refresh(); onClose(); }
    } catch { setErr("Network error."); }
    finally { setBusy(false); }
  }

  // advertisers list always includes the current value (in case it's something custom)
  const advOptions = ADVERTISERS.includes(advertiser) ? ADVERTISERS : [advertiser, ...ADVERTISERS];

  return (
    <div className="fixed inset-0 z-50" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-800 bg-panel p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-neutral-50">Edit {level === "campaign" ? "campaign" : "ad set"}</div>
            <div className="mt-0.5 max-w-[20rem] truncate text-xs text-neutral-500">{name}</div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-500 hover:bg-surface-200 hover:text-neutral-100">✕</button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-neutral-600">Loading current settings…</p>
        ) : (
          <div className="mt-5 space-y-4">
            {level === "campaign" ? (
              <>
                <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-500 shadow-xs">
                  Objective <span className="text-neutral-300">Leads</span> · Buying type <span className="text-neutral-300">Auction</span> (fixed)
                </div>
                <div><label className={label}>Daily budget (€)</label><input type="number" min={1} className={input} value={dailyBudgetEur} onChange={(e) => setDailyBudgetEur(e.target.value)} placeholder="e.g. 15" /></div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label}>Age min</label><input type="number" min={13} max={65} className={input} value={ageMin} onChange={(e) => setAgeMin(Number(e.target.value))} /></div>
                  <div><label className={label}>Age max</label><input type="number" min={13} max={65} className={input} value={ageMax} onChange={(e) => setAgeMax(Number(e.target.value))} /></div>
                </div>
                <div>
                  <label className={label}>Advertiser (EU disclosure)</label>
                  <div className="mt-1">
                    <AppSelect value={advertiser} onChange={setAdvertiser} className="w-full" options={advOptions.map((a) => ({ value: a, label: a }))} />
                  </div>
                </div>
                <div>
                  <label className={label}>Platforms</label>
                  <div className="mt-2 flex gap-4">
                    <label className="flex items-center gap-1.5 text-sm text-neutral-300"><input type="checkbox" checked={fb} onChange={(e) => setFb(e.target.checked)} /> Facebook</label>
                    <label className="flex items-center gap-1.5 text-sm text-neutral-300"><input type="checkbox" checked={ig} onChange={(e) => setIg(e.target.checked)} /> Instagram</label>
                  </div>
                </div>
                <div>
                  <label className={label}>Placements</label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {PLACEMENT_GROUPS.map((g) => (
                      <label key={g.key} className="flex items-center gap-1.5 text-sm text-neutral-300">
                        <input type="checkbox" checked={!!placements[g.key]} onChange={(e) => setPlacements((s) => ({ ...s, [g.key]: e.target.checked }))} /> {g.label}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-neutral-600">Only the placements you check are used — excluded ones get zero spend (no "limited spend").</p>
                </div>
                <p className="text-xs text-neutral-600">Saving re-submits the ads for Facebook review (normal — not live).</p>
              </>
            )}

            {err && <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">{err}</div>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} disabled={busy} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50">Cancel</button>
              <button onClick={publish} disabled={busy} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50">{busy ? "Publishing…" : "Publish"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
