/**
 * Placement groups → Meta position enums (verified against the official Marketing API
 * Placement Targeting reference, 2026-06). Client + server safe (no imports).
 *
 * The four groups the dashboard exposes (Feeds / Stories / Reels / In-stream). Positions NOT in
 * any group (FB right_hand_column/search/notification, IG explore/explore_home/ig_search) are
 * intentionally excluded — and because we never set `placement_soft_opt_out`, excluded = zero spend.
 */
export type PlacementKey = "feeds" | "stories" | "reels" | "instream";

export const PLACEMENT_GROUPS: { key: PlacementKey; label: string; fb: string[]; ig: string[] }[] = [
  // NB: "video_feeds" is in Meta's docs enum but is DEPRECATED and rejected on write — do not add it back.
  { key: "feeds", label: "Feeds", fb: ["feed", "profile_feed", "marketplace"], ig: ["stream", "profile_feed"] },
  { key: "stories", label: "Stories", fb: ["story"], ig: ["story"] },
  { key: "reels", label: "Reels", fb: ["facebook_reels"], ig: ["reels"] },
  { key: "instream", label: "In-stream", fb: ["instream_video"], ig: [] },
];

export type PlacementGroups = Record<PlacementKey, boolean>;

/** Derive which groups are "on" from the current position arrays (a group is on if any of its enums is present). */
export function derivePlacementGroups(fbPositions: string[] = [], igPositions: string[] = []): PlacementGroups {
  const present = new Set([...(fbPositions || []), ...(igPositions || [])]);
  const out = {} as PlacementGroups;
  for (const g of PLACEMENT_GROUPS) {
    out[g.key] = g.fb.some((e) => present.has(e)) || g.ig.some((e) => present.has(e));
  }
  return out;
}

/** Build the position arrays from checked groups, filtered by which platforms are enabled. */
export function buildPositions(groups: PlacementGroups, fb: boolean, ig: boolean): { facebook_positions?: string[]; instagram_positions?: string[] } {
  const fbPos = new Set<string>();
  const igPos = new Set<string>();
  for (const g of PLACEMENT_GROUPS) {
    if (!groups[g.key]) continue;
    if (fb) g.fb.forEach((e) => fbPos.add(e));
    if (ig) g.ig.forEach((e) => igPos.add(e));
  }
  return {
    facebook_positions: fb && fbPos.size ? [...fbPos] : undefined,
    instagram_positions: ig && igPos.size ? [...igPos] : undefined,
  };
}

export const anyGroupOn = (g: PlacementGroups) => PLACEMENT_GROUPS.some((x) => g[x.key]);
