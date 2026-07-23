"use client";

import { useState } from "react";
import { cn } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { PLACEMENT_GROUPS } from "@/lib/placements";
import { ModalCard } from "./ModalCard";
import { Select } from "./Select";
import { Toggle } from "./cells";
import { ChevronDownIcon, TrashIcon } from "../icons";
import { OPTIMIZATION_GOALS, audienceFromPreset, presetPayload } from "../audience";
import { ALL_COUNTRIES } from "@/lib/countries";
import type { LaunchAudience, Preset } from "../types";

const AGE_LO = 13;
const AGE_HI = 65;

const GENDER_OPTS = [
  { id: "all", name: "All genders" },
  { id: "men", name: "Men" },
  { id: "women", name: "Women" },
];
const ATTRIBUTION_OPTS = [
  { id: "1", name: "1-day click" },
  { id: "7", name: "7-day click" },
];

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="mono-label block">{children}</label>
);

export function LaunchSettingsModal({
  audience,
  setAudience,
  defaultWebsiteUrl,
  name,
  setName,
  presetId,
  setPresetId,
  presets,
  setPresets,
  onClose,
}: {
  audience: LaunchAudience;
  setAudience: (a: LaunchAudience) => void;
  defaultWebsiteUrl?: string;
  name?: string;
  setName?: (n: string) => void;
  presetId: string | null;
  setPresetId: (id: string | null) => void;
  presets: Preset[];
  setPresets: (p: Preset[]) => void;
  onClose: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busyAction, setBusyAction] = useState<"save" | "delete" | null>(null);
  const busy = busyAction !== null;
  const [countryQuery, setCountryQuery] = useState("");

  // Manual edits make the audience "Custom" (no longer matching a saved preset).
  const edit = (patch: Partial<LaunchAudience>) => {
    setAudience({ ...audience, ...patch });
    setPresetId(null);
  };
  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setAudience(audienceFromPreset(p));
    setPresetId(id);
  };

  const addCountry = (code: string) => { if (!audience.countries.includes(code)) edit({ countries: [...audience.countries, code] }); };
  const removeCountry = (code: string) => edit({ countries: audience.countries.filter((c) => c !== code) });
  const countryName = (code: string) => ALL_COUNTRIES.find((c) => c.code === code)?.name ?? code;
  const q = countryQuery.trim().toLowerCase();
  const countryMatches = q
    ? ALL_COUNTRIES.filter((c) => !audience.countries.includes(c.code) && (c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q)).slice(0, 6)
    : [];
  function togglePlacement(key: string) {
    const has = audience.placements.includes(key);
    edit({ placements: has ? audience.placements.filter((p) => p !== key) : [...audience.placements, key] });
  }
  const genderValue = audience.genders == null ? "all" : audience.genders.includes(1) ? "men" : "women";
  const setGender = (v: string | null) => edit({ genders: v === "men" ? [1] : v === "women" ? [2] : null });

  async function savePreset() {
    if (busy) return;
    const presetName = window.prompt("Name this preset", (name || "").trim() || "My audience")?.trim();
    if (!presetName) return;
    setBusyAction("save");
    try {
      const res = await fetch("/api/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(presetPayload(presetName, audience, "LEARN_MORE", null)),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.preset) { toast(j.error || "Couldn't save preset", "error"); return; }
      setPresets([...presets, j.preset as Preset]);
      setPresetId(j.preset.id);
      toast(`Saved preset "${presetName}"`);
    } finally {
      setBusyAction(null);
    }
  }

  async function deletePreset() {
    if (busy || !presetId) return;
    const p = presets.find((x) => x.id === presetId);
    if (!p || !window.confirm(`Delete preset "${p.name}"?`)) return;
    setBusyAction("delete");
    try {
      const res = await fetch(`/api/presets?id=${encodeURIComponent(presetId)}`, { method: "DELETE" });
      if (!res.ok) { toast("Couldn't delete preset", "error"); return; }
      setPresets(presets.filter((x) => x.id !== presetId));
      setPresetId(null);
      toast("Preset deleted");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <ModalCard title="Audience & settings" onClose={onClose} width="max-w-xl"
      footer={<button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none">Done</button>}>
      {/* Ad set name */}
      {setName && (
        <div className="mb-4">
          <Label>Ad set name</Label>
          <input
            value={name ?? ""}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ad set name"
            className="mt-1 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
          />
        </div>
      )}
      {/* Preset row */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label>Preset</Label>
          <div className="mt-1">
            <Select
              value={presetId}
              onChange={(v) => v && applyPreset(v)}
              options={presets.map((p) => ({ id: p.id, name: p.name }))}
              placeholder={presets.length ? "Custom (not saved)" : "No presets yet"}
            />
          </div>
        </div>
        <button onClick={savePreset} disabled={busy} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50">
          {busyAction === "save" && <span className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-neutral-200" />}
          {busyAction === "save" ? "Saving…" : "Save as preset"}
        </button>
        {presetId && (
          <button onClick={deletePreset} disabled={busy} aria-label="Delete preset" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 bg-neutral-700/30 text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 focus-visible:outline-none disabled:opacity-50">
            {busyAction === "delete" ? <span className="block h-4 w-4 animate-spin rounded-full border border-neutral-600 border-t-neutral-200" /> : <TrashIcon className="h-4 w-4" />}
          </button>
        )}
      </div>

      <div className="my-4 border-t border-neutral-800" />

      {/* Audience */}
      <div className="space-y-4">
        <div>
          <Label>Countries</Label>
          {audience.countries.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {audience.countries.map((code) => (
                <span key={code} className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                  {countryName(code)}
                  <button onClick={() => removeCountry(code)} aria-label={`Remove ${countryName(code)}`} className="text-accent/70 hover:text-accent">✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="relative mt-1.5">
            <input
              value={countryQuery}
              onChange={(e) => setCountryQuery(e.target.value)}
              placeholder="Search countries…"
              className="h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
            />
            {countryMatches.length > 0 && (
              <div className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
                {countryMatches.map((c) => (
                  <button key={c.code} onClick={() => { addCountry(c.code); setCountryQuery(""); }} className="block w-full px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-surface-200">
                    {c.name} <span className="text-neutral-600">· {c.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {audience.countries.length === 0 && <p className="mt-1 text-[11px] text-amber-400/80">No country selected — Portugal will be used.</p>}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label>Age range</Label>
            <span className="text-xs font-medium text-neutral-300">{audience.ageMin} – {audience.ageMax >= AGE_HI ? "65+" : audience.ageMax}</span>
          </div>
          <div className="relative mt-3 h-5">
            <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-neutral-800" />
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent"
              style={{ left: `${((audience.ageMin - AGE_LO) / (AGE_HI - AGE_LO)) * 100}%`, right: `${100 - ((audience.ageMax - AGE_LO) / (AGE_HI - AGE_LO)) * 100}%` }}
            />
            <input
              type="range" min={AGE_LO} max={AGE_HI} value={audience.ageMin}
              onChange={(e) => edit({ ageMin: Math.min(Number(e.target.value), audience.ageMax) })}
              aria-label="Minimum age"
              className="range-thumb absolute inset-x-0 top-1/2 h-4 w-full -translate-y-1/2"
            />
            <input
              type="range" min={AGE_LO} max={AGE_HI} value={audience.ageMax}
              onChange={(e) => edit({ ageMax: Math.max(Number(e.target.value), audience.ageMin) })}
              aria-label="Maximum age"
              className="range-thumb absolute inset-x-0 top-1/2 h-4 w-full -translate-y-1/2"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Gender</Label>
            <div className="mt-1">
              <Select value={genderValue} onChange={setGender} options={GENDER_OPTS} placeholder="All genders" />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Toggle on={audience.facebook} onChange={(v) => edit({ facebook: v })} label="Facebook" />
            <span className="text-sm text-neutral-300">Facebook</span>
          </div>
          <div className="flex items-center gap-2">
            <Toggle on={audience.instagram} onChange={(v) => edit({ instagram: v })} label="Instagram" />
            <span className="text-sm text-neutral-300">Instagram</span>
          </div>
          <div className="flex items-center gap-2">
            <Toggle on={audience.advantageAudience} onChange={(v) => edit({ advantageAudience: v })} label="Advantage+ Audience" />
            <span className="text-sm text-neutral-300">Advantage+ Audience</span>
          </div>
        </div>

        {/* Destination: instant form vs landing page (website conversions) */}
        <div>
          <Label>Where the ad sends people</Label>
          <div className="mt-1.5 inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-xs">
            <button
              onClick={() => edit({ destination: "form" })}
              className={cn("rounded px-3 py-1.5 font-medium transition-colors", audience.destination !== "site" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}
            >
              Instant form
            </button>
            <button
              onClick={() => edit({ destination: "site" })}
              className={cn("rounded px-3 py-1.5 font-medium transition-colors", audience.destination === "site" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}
            >
              Landing page
            </button>
          </div>
          {/* Destination URL — the landing page (site) or the after-submit redirect (form). Shows in the Link column. */}
          <div className="mt-2 space-y-1">
            <input
              value={audience.landingUrl}
              onChange={(e) => edit({ landingUrl: e.target.value })}
              placeholder={defaultWebsiteUrl || "https://your-landing-page.com"}
              inputMode="url"
              className="h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
            />
            {audience.destination === "site" && (
              <p className="text-[11px] leading-snug text-neutral-600">
                The landing page this ad sends people to — shown in the Link column.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Advanced */}
      <button onClick={() => setShowAdvanced((s) => !s)} className="mt-4 flex w-full items-center gap-2 border-t border-neutral-800 pt-3 text-left text-sm font-medium text-neutral-300">
        <ChevronDownIcon className={cn("h-4 w-4 transition-transform", showAdvanced && "rotate-180")} />
        Advanced settings
        <span className="ml-1 text-xs font-normal text-neutral-600">placements · optimization · attribution</span>
      </button>
      {showAdvanced && (
        <div className="mt-3 space-y-4">
          <div>
            <Label>Placements</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PLACEMENT_GROUPS.map((g) => {
                const on = audience.placements.includes(g.key);
                return (
                  <button key={g.key} onClick={() => togglePlacement(g.key)}
                    className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", on ? "border-accent/30 bg-accent/10 text-accent" : "border-neutral-700 text-neutral-400 hover:text-neutral-200")}>
                    {g.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-neutral-600">{audience.placements.length ? "Only the selected placements will run." : "Automatic — Meta picks the best placements (recommended)."}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Optimization</Label>
              <div className="mt-1"><Select value={audience.optimizationGoal} onChange={(v) => edit({ optimizationGoal: v ?? "LEAD_GENERATION" })} options={OPTIMIZATION_GOALS} placeholder="Maximize leads" /></div>
            </div>
            <div>
              <Label>Attribution</Label>
              <div className="mt-1"><Select value={String(audience.attributionDays)} onChange={(v) => edit({ attributionDays: Number(v) || 1 })} options={ATTRIBUTION_OPTS} placeholder="1-day click" /></div>
            </div>
          </div>
        </div>
      )}
    </ModalCard>
  );
}
