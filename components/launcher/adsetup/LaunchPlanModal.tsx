"use client";

import { ModalCard } from "./ModalCard";
import { AlertTriangleIcon } from "../icons";

export type PlanShape = { adSets: number; ads: number; perDay: number | null };

/**
 * Shown before launching when some ads carry multiple copy variations. Meta builds those as Dynamic
 * Creative ads, and a Dynamic Creative ad set can hold exactly ONE ad — so each such ad is forced into
 * its own ad set, which silently breaks the ad-set grouping the user set up on the board. Spell out both
 * outcomes (ad sets + real daily spend) and let them pick.
 */
export function LaunchPlanModal({
  variationAds,
  withVars,
  stripped,
  onKeepVariations,
  onFirstCopyOnly,
  onClose,
}: {
  variationAds: number;
  withVars: PlanShape;
  stripped: PlanShape;
  onKeepVariations: () => void;
  onFirstCopyOnly: () => void;
  onClose: () => void;
}) {
  const eur = (n: number | null) => (n == null ? "—" : `€${Number.isInteger(n) ? n : n.toFixed(2)}/day`);
  const line = (p: PlanShape) => `${p.adSets} ad set${p.adSets === 1 ? "" : "s"} · ${p.ads} ad${p.ads === 1 ? "" : "s"} · ${eur(p.perDay)}`;

  return (
    <ModalCard
      title="Copy variations change your ad sets"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <button onClick={onClose} className="mr-auto inline-flex h-7 items-center justify-center rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
          Cancel
        </button>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-xs leading-relaxed text-neutral-300">
            <span className="font-medium text-neutral-100">{variationAds} ad{variationAds === 1 ? " has" : "s have"} more than one copy variation.</span>{" "}
            Meta runs those as Dynamic Creative, and a Dynamic Creative ad set holds exactly one ad — so each of those ads
            gets its <span className="font-medium text-neutral-100">own</span> ad set instead of going into the ad sets you set up.
          </p>
        </div>

        <div className="space-y-2">
          <button
            onClick={onFirstCopyOnly}
            className="flex w-full flex-col items-start gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-left shadow-xs transition-colors hover:border-accent/50"
          >
            <span className="text-sm font-medium text-neutral-100">Keep my ad sets — use the first copy only</span>
            <span className="text-xs text-neutral-500">Your grouping is respected. Extra variations are dropped for this launch (nothing in the table changes).</span>
            <span className="mt-0.5 font-mono text-[11px] tabular-nums text-accent">{line(stripped)}</span>
          </button>

          <button
            onClick={onKeepVariations}
            className="flex w-full flex-col items-start gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-left shadow-xs transition-colors hover:border-accent/50"
          >
            <span className="text-sm font-medium text-neutral-100">Keep the variations — one ad set per ad</span>
            <span className="text-xs text-neutral-500">Meta rotates each ad&apos;s copy and optimizes. Your ad-set grouping is replaced by one ad set per ad.</span>
            <span className="mt-0.5 font-mono text-[11px] tabular-nums text-amber-300">{line(withVars)}</span>
          </button>
        </div>

        <p className="text-[11px] leading-snug text-neutral-600">Everything launches PAUSED either way — nothing spends until you turn it on.</p>
      </div>
    </ModalCard>
  );
}
