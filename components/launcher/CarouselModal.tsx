"use client";

import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { PlusIcon, XIcon, GripIcon, VideoIcon } from "./icons";
import { ModalShell, ModalHeader, ModalFooter, Divider, CreativeThumb, newGroupId } from "./GroupingShared";
import { useRatios } from "./ratio";
import type { UploadedCreative, Group } from "./types";

export function CarouselModal({
  creatives,
  carousels,
  setCarousels,
  onBack,
  onClose,
  onContinue,
}: {
  creatives: UploadedCreative[];
  carousels: Group[];
  setCarousels: Dispatch<SetStateAction<Group[]>>;
  onBack: () => void;
  onClose: () => void;
  onContinue: (adCount: number) => void;
}) {
  const ratios = useRatios(creatives);
  const byId = useMemo(() => new Map(creatives.map((c) => [c.id, c])), [creatives]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ cz: string; i: number } | null>(null);

  const MAX_CARDS = 10; // Meta's standard carousel cap — a >10-card carousel is rejected at launch (NP3)
  const groupedIds = useMemo(() => new Set(carousels.flatMap((c) => c.creativeIds)), [carousels]);
  const ungrouped = creatives.filter((c) => !groupedIds.has(c.id));
  const adCount = carousels.length;
  const canCreate = selected.size >= 2 && selected.size <= MAX_CARDS;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_CARDS) next.add(id); // don't let the user build an over-cap carousel Meta will reject
      return next;
    });
  }

  function createCarousel() {
    if (selected.size < 2 || selected.size > MAX_CARDS) return;
    setCarousels((prev) => [...prev, { id: newGroupId(), creativeIds: Array.from(selected) }]);
    setSelected(new Set());
  }

  // Remove a card; if a carousel drops below 2 cards it dissolves (remaining card returns to ungrouped).
  function removeCard(czId: string, creativeId: string) {
    setCarousels((prev) =>
      prev.flatMap((c) => {
        if (c.id !== czId) return [c];
        const ids = c.creativeIds.filter((id) => id !== creativeId);
        return ids.length >= 2 ? [{ ...c, creativeIds: ids }] : [];
      })
    );
  }

  function reorder(czId: string, from: number, to: number) {
    if (from === to) return;
    setCarousels((prev) =>
      prev.map((c) => {
        if (c.id !== czId) return c;
        const ids = [...c.creativeIds];
        const [moved] = ids.splice(from, 1);
        ids.splice(to, 0, moved);
        return { ...c, creativeIds: ids };
      })
    );
  }

  return (
    <ModalShell onBackdrop={onClose} ariaLabel="Carousel Ad">
      <ModalHeader title="Carousel Ad" adCount={adCount} onBack={onBack} onClose={onClose} />

      <div className="space-y-6 p-5">
        {carousels.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-neutral-400">Carousels group creatives into one swipeable ad. Drag cards to reorder.</p>
            {carousels.map((c) => (
              <div key={c.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs">
                <div className="flex items-center gap-2">
                  <GripIcon className="h-4 w-4 text-neutral-600" />
                  <span className="text-sm font-semibold text-neutral-100">Carousel Ad</span>
                  <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400">
                    {c.creativeIds.length} cards
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  {c.creativeIds.map((id, i) => {
                    const cr = byId.get(id);
                    if (!cr) return null;
                    return (
                      <div
                        key={id}
                        draggable
                        onDragStart={() => setDrag({ cz: c.id, i })}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (drag && drag.cz === c.id) reorder(c.id, drag.i, i);
                          setDrag(null);
                        }}
                        className="group relative h-24 w-24 cursor-grab overflow-hidden rounded-lg ring-1 ring-inset ring-neutral-700 active:cursor-grabbing"
                      >
                        {cr.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cr.previewUrl} alt={cr.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-400">
                            <VideoIcon className="h-6 w-6" />
                          </div>
                        )}
                        <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] font-semibold text-white">
                          {i + 1}
                        </span>
                        {ratios[id] && (
                          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1 py-0.5 text-[10px] font-medium text-white">
                            {ratios[id]}
                          </span>
                        )}
                        <button
                          onClick={() => removeCard(c.id, id)}
                          aria-label={`Remove ${cr.name} from carousel`}
                          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-neutral-300 opacity-0 transition-opacity hover:bg-black hover:text-white group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3">
          <Divider label={`Ungrouped (${ungrouped.length})`} />
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-neutral-400">Select creatives to group them into a new carousel.</p>
            {canCreate && (
              <button
                onClick={createCarousel}
                className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
              >
                <PlusIcon className="h-4 w-4" /> Create Carousel ({selected.size})
              </button>
            )}
          </div>
          {ungrouped.length === 0 ? (
            <p className="text-sm text-neutral-600">All creatives are in a carousel.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {ungrouped.map((c) => (
                <CreativeThumb key={c.id} creative={c} ratio={ratios[c.id]} selected={selected.has(c.id)} onToggle={() => toggle(c.id)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Block Continue while creatives remain ungrouped — otherwise each becomes an invalid 1-card carousel (N-launcher-secondary-0). */}
      <ModalFooter
        adCount={adCount}
        disabled={adCount === 0 || ungrouped.length > 0}
        note={ungrouped.length > 0 ? `Group the ${ungrouped.length} remaining creative${ungrouped.length === 1 ? "" : "s"} into a carousel to continue` : undefined}
        onContinue={() => onContinue(adCount)}
      />
    </ModalShell>
  );
}
