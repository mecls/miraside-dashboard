"use client";

import { useEffect, useState } from "react";
import { ModalCard } from "./ModalCard";
import type { AdRow, UploadedCreative } from "../types";

// Friendly labels for the 10 placement surfaces /api/ads/preview renders.
const LABELS: Record<string, string> = {
  MOBILE_FEED_STANDARD: "Facebook Feed",
  DESKTOP_FEED_STANDARD: "Facebook Feed · Desktop",
  FACEBOOK_STORY_MOBILE: "Facebook Story",
  FACEBOOK_REELS_MOBILE: "Facebook Reels",
  MARKETPLACE_MOBILE: "Marketplace",
  RIGHT_COLUMN_STANDARD: "Right Column",
  INSTAGRAM_STANDARD: "Instagram Feed",
  INSTAGRAM_STORY: "Instagram Story",
  INSTAGRAM_REELS: "Instagram Reels",
  INSTAGRAM_EXPLORE_CONTEXTUAL: "Instagram Explore",
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

/** Render the real Facebook/Instagram previews for one grid row, across all placements. */
export function PreviewModal({ row, creatives, onClose }: { row: AdRow; creatives: UploadedCreative[]; onClose: () => void }) {
  const [previews, setPreviews] = useState<{ format: string; body: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const byId = new Map(creatives.map((c) => [c.id, c]));
      const firstImage = row.creativeIds.map((id) => byId.get(id)).find((c) => c && c.kind === "image");
      if (!firstImage) { setError("Preview isn't available for video-only ads yet."); return; }
      try {
        const imageBase64 = await fileToDataUrl(firstImage.file);
        const res = await fetch("/api/ads/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: row.primaryText[0] || "", headline: row.headline[0] || "", callToAction: row.cta, imageBase64 }),
        });
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !Array.isArray(j.previews) || !j.previews.length) { setError(j.error || "Couldn't generate the preview."); return; }
        setPreviews(j.previews);
      } catch {
        if (!cancelled) setError("Couldn't generate the preview.");
      }
    })();
    return () => { cancelled = true; };
    // Key on the fields the preview request actually uses, not the whole `row` object — otherwise an
    // unrelated patch (e.g. auto-name filling row.name) changed the row's identity and re-fired the Meta
    // preview call on every parent render (C54).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.primaryText[0], row.headline[0], row.cta, row.creativeIds[0], creatives]);

  return (
    <ModalCard title="Ad preview" subtitle={`${row.name} — across every placement`} onClose={onClose} width="max-w-4xl">
      {!previews && !error && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-neutral-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
          Rendering previews…
        </div>
      )}
      {error && <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-4 py-8 text-center text-sm text-neutral-400">{error}</div>}
      {previews && (
        <div className="grid max-h-[70vh] gap-5 overflow-y-auto sm:grid-cols-2">
          {previews.map((p) => (
            <div key={p.format} className="min-w-0">
              <div className="mono-label mb-1.5">{LABELS[p.format] ?? p.format}</div>
              {/* Only inject Meta's expected sandboxed <iframe> preview — never arbitrary markup, and never a <script> (C53). */}
              <div className="overflow-auto rounded-lg border border-neutral-800 bg-white p-1" dangerouslySetInnerHTML={{ __html: /<iframe[\s>]/i.test(p.body || "") && !/<script/i.test(p.body || "") ? p.body : "" }} />
            </div>
          ))}
        </div>
      )}
    </ModalCard>
  );
}
