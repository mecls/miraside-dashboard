"use client";

import { useRef, useState } from "react";
import { ModalCard } from "./ModalCard";

export type FeedCrop = { x: number; y: number; w: number; h: number };

/**
 * Per-ad Feed framing. Left: the full (usually 9:16) image with a draggable 4:5 frame — the user positions
 * it over the part that should show on Feed. Right: a LIVE result — exactly how Feed (4:5) and Stories (full)
 * will look, updating as they drag. We store the frame as a normalized rect (0–1 of the image); at launch it
 * becomes Meta `image_crops` for the Feed placement. Stories/Reels always keep the full image.
 */
export function CropModal({
  imageUrl,
  crop,
  onSave,
  onClose,
}: {
  imageUrl: string;
  crop?: FeedCrop | null;
  onSave: (crop: FeedCrop) => void;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState<number | null>(null); // image width / height
  // The 4:5 frame keeps the full width, so its height as a fraction of the image = 1.25 × (w/h). For a
  // 9:16 image that's ~0.70, leaving vertical room to slide; for a 4:5-or-wider image there's no room.
  const hNorm = aspect ? Math.min(1, 1.25 * aspect) : 0.7;
  const yMax = Math.max(0, 1 - hNorm);
  const tooWide = aspect != null && aspect >= 0.8; // already ≤ 4:5 tall — nothing to crop

  const [y, setY] = useState<number>(crop?.y ?? 0.15);
  const clampedY = Math.min(yMax, Math.max(0, y));
  // Vertical framing for the live Feed preview: object-position that shows exactly the [clampedY, +hNorm] slice.
  const feedPosY = yMax > 0 ? (clampedY / yMax) * 100 : 50;

  const drag = useRef<{ startY: number; startTop: number } | null>(null);
  function onDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, startTop: clampedY };
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current || !wrapRef.current) return;
    const h = wrapRef.current.getBoundingClientRect().height || 1;
    setY(Math.min(yMax, Math.max(0, drag.current.startTop + (e.clientY - drag.current.startY) / h)));
  }

  return (
    <ModalCard
      title="Frame for Feed"
      subtitle="Drag the box to pick what shows on Feed (4:5). The right side is exactly how each placement will look."
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          {!tooWide && (
            <div className="mr-auto flex gap-1">
              {([["Top", 0], ["Center", yMax / 2], ["Bottom", yMax]] as const).map(([label, v]) => (
                <button
                  key={label}
                  onClick={() => setY(v)}
                  className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => onSave({ x: 0, y: clampedY, w: 1, h: hNorm })}
            className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
          >
            Done
          </button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[1fr_150px]">
        {/* Editor: full image + draggable 4:5 frame */}
        <div>
          <div className="mono-label mb-1.5">Drag the frame</div>
          <div
            ref={wrapRef}
            className="relative mx-auto w-full max-w-[240px] touch-none select-none overflow-hidden rounded-lg bg-black"
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              className="block w-full select-none"
              onLoad={(e) => setAspect(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))}
            />
            {!tooWide && (
              <>
                <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/65" style={{ height: `${clampedY * 100}%` }} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65" style={{ height: `${Math.max(0, 1 - clampedY - hNorm) * 100}%` }} />
                <div
                  onPointerDown={onDown}
                  className="absolute inset-x-0 cursor-grab border-2 border-accent active:cursor-grabbing"
                  style={{ top: `${clampedY * 100}%`, height: `${hNorm * 100}%` }}
                >
                  <span className="absolute left-1 top-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-neutral-950">Feed 4:5</span>
                </div>
              </>
            )}
            {tooWide && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 px-4 text-center text-xs text-neutral-200">
                This image already fits Feed — no cropping needed.
              </div>
            )}
          </div>
        </div>

        {/* Live result: exactly how Feed (4:5) and Stories/Reels (full) will look */}
        <div className="space-y-4">
          <div>
            <div className="mono-label mb-1.5">Feed · 4:5</div>
            <div className="w-full overflow-hidden rounded-lg bg-black ring-1 ring-inset ring-neutral-800" style={{ aspectRatio: "4 / 5" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="" draggable={false} className="h-full w-full object-cover" style={{ objectPosition: `50% ${feedPosY}%` }} />
            </div>
          </div>
          <div>
            <div className="mono-label mb-1.5">Stories · Reels</div>
            <div className="w-full overflow-hidden rounded-lg bg-black ring-1 ring-inset ring-neutral-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="" draggable={false} className="block w-full" />
            </div>
          </div>
        </div>
      </div>
    </ModalCard>
  );
}
