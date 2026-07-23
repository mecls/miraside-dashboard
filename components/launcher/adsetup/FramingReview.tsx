"use client";

import { useMemo, useState } from "react";
import { ModalCard } from "./ModalCard";
import { CropModal } from "./CropModal";
import type { AdRow, UploadedCreative } from "../types";

/**
 * Framing review — the step BETWEEN choosing the format and the Ad Setup sheet (single-image launches only).
 * Shows every image ad on both shapes side by side: Stories/Reels (the full 9:16) and Feed (the 4:5 crop),
 * so you see exactly how each will look before setup. Adjust any crop, then Accept them one by one — or
 * Accept all — to continue. The crop is stored on AdRow.feedCrop, so it carries straight through to launch.
 */
export function FramingReview({
  rows,
  setRows,
  creatives,
  onBack,
  onContinue,
}: {
  rows: AdRow[];
  setRows: (fn: (prev: AdRow[]) => AdRow[]) => void;
  creatives: UploadedCreative[];
  onBack: () => void;
  onContinue: () => void;
}) {
  const byId = useMemo(() => new Map(creatives.map((c) => [c.id, c])), [creatives]);
  const cards = useMemo(() => rows.filter((r) => r.format === "single" && byId.get(r.creativeIds[0])?.kind === "image"), [rows, byId]);

  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [adjustId, setAdjustId] = useState<string | null>(null);
  const [aspects, setAspects] = useState<Record<string, number>>({}); // creativeId → width/height

  const allAccepted = cards.length > 0 && cards.every((c) => accepted.has(c.id));

  function toggleAccept(id: string) {
    setAccepted((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function acceptAll() { setAccepted(new Set(cards.map((c) => c.id))); }
  function setCrop(id: string, feedCrop: AdRow["feedCrop"]) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, feedCrop } : r)));
  }

  const adjustRow = adjustId ? cards.find((c) => c.id === adjustId) : null;
  const adjustCreative = adjustRow ? byId.get(adjustRow.creativeIds[0]) : null;

  return (
    <ModalCard
      title="Check the framing"
      subtitle="See each ad on Stories (9:16) and Feed (4:5). Adjust any crop, then accept to continue."
      onClose={onBack}
      width="max-w-4xl"
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-neutral-500">{accepted.size} / {cards.length} reviewed</span>
          <div className="ml-auto flex gap-2">
            <button onClick={acceptAll} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none">
              Accept all
            </button>
            <button
              onClick={onContinue}
              disabled={!allAccepted}
              className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue to setup →
            </button>
          </div>
        </div>
      }
    >
      <div className="grid max-h-[68vh] gap-4 overflow-y-auto sm:grid-cols-2">
        {cards.map((card) => {
          const c = byId.get(card.creativeIds[0])!;
          const aspect = aspects[c.id];
          const hNorm = aspect ? Math.min(1, 1.25 * aspect) : 0.7;
          const yMax = Math.max(0, 1 - hNorm);
          const tooWide = aspect != null && aspect >= 0.8; // already ≤ 4:5 tall — nothing to crop
          const cropY = card.feedCrop?.y ?? yMax / 2; // default: centered
          const feedPosY = yMax > 0 ? (cropY / yMax) * 100 : 50;
          const isAcc = accepted.has(card.id);

          return (
            <div key={card.id} className={`rounded-lg border p-3 transition-colors ${isAcc ? "border-emerald-500/40 bg-emerald-500/5" : "border-neutral-800 bg-neutral-900"}`}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="truncate text-sm font-medium text-neutral-200">{card.name}</div>
                {card.feedCrop && !tooWide && <span className="shrink-0 text-[10px] font-medium text-accent">✓ custom crop</span>}
              </div>

              <div className="flex gap-3">
                {/* Stories / Reels — the full image */}
                <figure className="min-w-0 flex-1 space-y-1">
                  <div className="overflow-hidden rounded-lg bg-black ring-1 ring-inset ring-neutral-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.previewUrl}
                      alt=""
                      draggable={false}
                      className="block w-full"
                      onLoad={(e) => {
                        // Read the dimensions SYNCHRONOUSLY — inside the state updater `e.currentTarget` is null.
                        const ratio = e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight);
                        setAspects((m) => (m[c.id] ? m : { ...m, [c.id]: ratio }));
                      }}
                    />
                  </div>
                  <figcaption className="text-center text-[10px] text-neutral-500">Stories · Reels</figcaption>
                </figure>

                {/* Feed — the 4:5 crop */}
                <figure className="min-w-0 flex-1 space-y-1">
                  <div className="overflow-hidden rounded-lg bg-black ring-1 ring-inset ring-neutral-800" style={{ aspectRatio: "4 / 5" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.previewUrl} alt="" draggable={false} className="h-full w-full object-cover" style={{ objectPosition: `50% ${feedPosY}%` }} />
                  </div>
                  <figcaption className="text-center text-[10px] text-neutral-500">Feed · 4:5</figcaption>
                </figure>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => setAdjustId(card.id)}
                  disabled={tooWide}
                  title={tooWide ? "This image already fits Feed" : "Adjust the Feed crop"}
                  className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tooWide ? "Fits Feed" : "Adjust crop"}
                </button>
                <button
                  onClick={() => toggleAccept(card.id)}
                  className={`ml-auto inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none ${isAcc ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-transparent bg-accent text-neutral-950 hover:bg-accent-600"}`}
                >
                  {isAcc ? "✓ Accepted" : "Accept"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {adjustRow && adjustCreative && (
        <CropModal
          imageUrl={adjustCreative.previewUrl}
          crop={adjustRow.feedCrop}
          onSave={(crop) => { setCrop(adjustRow.id, crop); setAdjustId(null); }}
          onClose={() => setAdjustId(null)}
        />
      )}
    </ModalCard>
  );
}
