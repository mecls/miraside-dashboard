"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { cn } from "@/components/ui";

/**
 * Full-screen viewer for an ad creative — so the actual ad can be READ, not squinted at.
 * Shows the full-resolution creative_image_url when the ads sync has one; falls back to the
 * 600px thumbnail otherwise. Closes on backdrop click, ✕, or Escape.
 */
export function AdLightbox({ url, name, onClose }: { url: string; name: string | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The lightbox is rendered INSIDE the row it belongs to (no portal), so every close click — the
  // backdrop and the ✕ — must stopPropagation or it bubbles up to the row's own onClick. On the ad
  // scoreboard that now navigates to the Leads tab; on a lead row it toggles the row open. Closing a
  // creative must do neither.
  const close = (e: MouseEvent) => {
    e.stopPropagation();
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4" onClick={close}>
      <div className="absolute inset-0 bg-black/85 backdrop-blur-[2px]" />
      <button
        onClick={close}
        className="absolute right-4 top-4 z-10 rounded-md px-2.5 py-1.5 text-lg text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
        aria-label="Close"
      >
        ✕
      </button>
      <div className="relative z-10 flex max-h-full max-w-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={name ?? "Ad creative"}
          className="max-h-[85vh] max-w-[92vw] rounded-lg object-contain shadow-2xl ring-1 ring-white/10"
        />
        {name && <p className="max-w-[80vw] truncate text-center text-sm text-neutral-300">{name}</p>}
      </div>
    </div>
  );
}

/**
 * The little square ad image used across tables — click it to open the creative full-screen.
 * Renders a plain grey square when the ad has no image. stopPropagation so opening the
 * lightbox never also triggers the row's own click (expand / drawer / select).
 */
export function AdThumb({ thumb, full, name, size = "h-7 w-7" }: { thumb: string | null; full?: string | null; name?: string | null; size?: string }) {
  const [open, setOpen] = useState(false);
  const display = thumb ?? full ?? null;
  if (!display) return <span className={cn("inline-block shrink-0 rounded bg-neutral-800", size)} />;
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn("group/thumb relative shrink-0 cursor-zoom-in overflow-hidden rounded ring-1 ring-neutral-800 transition hover:ring-neutral-500", size)}
        title="Click to view the ad"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={display} alt="" className="h-full w-full object-cover" />
        <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-[10px] text-white group-hover/thumb:flex">⤢</span>
      </button>
      {open && <AdLightbox url={full ?? display} name={name ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}
