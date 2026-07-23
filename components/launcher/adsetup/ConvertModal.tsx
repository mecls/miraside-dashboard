"use client";

import { LayersIcon, AlertTriangleIcon } from "../icons";
import { ModalCard } from "./ModalCard";
import type { AdRow } from "../types";

export function ConvertModal({ rows, onConvert, onClose }: { rows: AdRow[]; onConvert: () => void; onClose: () => void }) {
  const n = rows.length;
  const hasMultiVariations = rows.some((r) => r.primaryText.length > 1 || r.headline.length > 1 || r.description.length > 1);

  return (
    <ModalCard
      title="Convert to Multi-Ratio"
      subtitle={`All ${n} ad${n === 1 ? "" : "s"} will be converted`}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
            Cancel
          </button>
          <button
            onClick={onConvert}
            className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
          >
            <LayersIcon className="h-4 w-4" /> Convert All Ads
          </button>
        </>
      }
    >
      {hasMultiVariations && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
          <AlertTriangleIcon className="h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <div className="text-sm font-semibold text-amber-300">Some ads have multiple copy variations</div>
            <p className="mt-1 text-xs text-amber-200/80">
              Multi-ratio ads only support 1 primary text, 1 headline, and 1 description. Converting will keep only the first variation of each field. All ads in this launch
              will be converted since formats cannot be mixed.
            </p>
          </div>
        </div>
      )}
      <div className="mono-label">After conversion</div>
      <ul className="mt-2 space-y-1.5 text-sm text-neutral-300">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-600" /> All {n} ad{n === 1 ? "" : "s"} will be converted to multi-ratio
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-600" /> A 9:16 version will be created for Stories &amp; Reels (at launch)
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-600" /> Only the first copy variation will be kept
        </li>
      </ul>
    </ModalCard>
  );
}
