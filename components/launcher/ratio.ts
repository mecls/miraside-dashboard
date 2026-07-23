import { useEffect, useState } from "react";
import type { UploadedCreative } from "./types";

// Common ad aspect ratios we snap measured dimensions to.
const RATIOS: [string, number][] = [
  ["9:16", 9 / 16],
  ["4:5", 4 / 5],
  ["1:1", 1],
  ["1.91:1", 1.91],
  ["16:9", 16 / 9],
];

/** Snap a width/height to the nearest common ad ratio label. */
export function ratioLabel(w: number, h: number): string {
  if (!w || !h) return "";
  const r = w / h;
  let best = RATIOS[0];
  let bestDiff = Infinity;
  for (const cand of RATIOS) {
    const diff = Math.abs(cand[1] - r);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  return best[0];
}

function measure(c: UploadedCreative): Promise<string> {
  return new Promise((resolve) => {
    if (c.kind === "image") {
      const img = new window.Image();
      img.onload = () => resolve(ratioLabel(img.naturalWidth, img.naturalHeight));
      img.onerror = () => resolve("");
      img.src = c.previewUrl;
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve(ratioLabel(v.videoWidth, v.videoHeight));
      v.onerror = () => resolve("");
      v.src = c.previewUrl;
    }
  });
}

/** Lazily measure each creative's aspect ratio in the browser; returns id -> label. */
export function useRatios(creatives: UploadedCreative[]): Record<string, string> {
  const [ratios, setRatios] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    for (const c of creatives) {
      if (ratios[c.id] !== undefined) continue;
      measure(c).then((label) => {
        if (!cancelled) setRatios((prev) => (prev[c.id] !== undefined ? prev : { ...prev, [c.id]: label }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatives]);
  return ratios;
}
