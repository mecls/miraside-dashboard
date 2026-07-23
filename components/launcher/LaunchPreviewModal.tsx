"use client";

import { useEffect, useState } from "react";
import { ModalCard } from "./adsetup/ModalCard";
import type { LaunchRow } from "./types";

/**
 * A quick, view-only preview of a launch/draft's ad images — shown bigger so you can confirm it's
 * the right one before opening it in the editor. For drafts it fetches fresh signed URLs for every
 * image creative; otherwise it falls back to the row's stored thumbnails.
 */
export function LaunchPreviewModal({ launch, onClose }: { launch: LaunchRow; onClose: () => void }) {
  // The History list only carries 3 thumbs per row, so ALWAYS fetch the full set here — signed URLs for a
  // draft's creatives, or every stored thumbnail once launched.
  const [images, setImages] = useState<{ name: string; url: string }[]>(
    launch.thumbUrls.map((u, i) => ({ name: `Ad ${i + 1}`, url: u }))
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/launches/${launch.id}?images=1`);
        const j = await res.json().catch(() => ({}));
        if (alive && Array.isArray(j.images) && j.images.length) setImages(j.images);
      } catch {
        // keep the thumbnail fallback
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [launch.id]);

  const count = launch.adCount || images.length;

  return (
    <ModalCard
      title={launch.name}
      subtitle={`${count} ad${count === 1 ? "" : "s"} · ${launch.status === "DRAFT" ? "draft preview" : "preview"}`}
      onClose={onClose}
      width="max-w-2xl"
      footer={<button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none">Close</button>}
    >
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
        </div>
      ) : images.length === 0 ? (
        <div className="py-16 text-center text-sm text-neutral-500">No preview images for this one.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {images.map((im, i) => (
            <figure key={i} className="space-y-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={im.url} alt={im.name} className="h-64 w-full rounded-lg bg-neutral-900 object-contain ring-1 ring-inset ring-neutral-800" />
              <figcaption className="truncate text-center text-xs text-neutral-400">{im.name}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {!loading && images.length > 0 && launch.status !== "DRAFT" && launch.adCount > images.length && (
        <p className="mt-4 text-center text-xs text-neutral-500">Showing {images.length} of {launch.adCount} ads — open Ads Manager to see them all.</p>
      )}
    </ModalCard>
  );
}
