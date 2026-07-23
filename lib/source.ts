/**
 * Attribution channel resolution + the strict "Channel — Detail" label format.
 * See SOURCE-TRACKING.md for the full model. Pure functions — no I/O.
 */

export const CHANNELS = [
  "Paid Ads",
  "YouTube",
  "Instagram",
  "LinkedIn",
  "X (Twitter)",
  "Cold Email",
  "Referral",
  "Website",
  "Direct",
  "Other",
] as const;
export type Channel = (typeof CHANNELS)[number];

const BY_LOWER = new Map<string, Channel>(CHANNELS.map((c) => [c.toLowerCase(), c]));

/** Map a form-declared source string to a canonical channel (case-insensitive + a few aliases). */
export function canonicalChannel(s?: string | null): Channel {
  const t = (s ?? "").trim();
  if (!t) return "Other";
  const exact = BY_LOWER.get(t.toLowerCase());
  if (exact) return exact;
  const l = t.toLowerCase();
  if (l === "x" || l.includes("twitter")) return "X (Twitter)";
  if (l.includes("youtube") || l === "yt") return "YouTube";
  if (l.includes("insta")) return "Instagram";
  if (l.includes("linked")) return "LinkedIn";
  if (l.includes("paid") || l === "ads") return "Paid Ads";
  return "Other";
}

interface SourceBody {
  ad_id?: string | null;
  source?: string | null;
  page_url?: string | null;
}

/** True when this lead is a paid ad click — the only case Meta conversions fire. */
export function isPaidClick(b: { ad_id?: string | null }): boolean {
  return !!(b.ad_id && String(b.ad_id).trim());
}

/** Resolve the attribution channel: ad_id → Paid Ads; else the form's declared source; else fallback. */
export function resolveChannel(b: SourceBody): Channel {
  if (isPaidClick(b)) return "Paid Ads";
  if (b.source && b.source.trim()) return canonicalChannel(b.source);
  if (b.page_url) {
    try {
      const u = new URL(b.page_url);
      if (u.pathname === "/" || u.pathname === "") return "Website";
    } catch {
      /* not a parseable URL — fall through */
    }
  }
  return "Other";
}

/** Compose the strict `Channel — Detail` label. No detail → just the channel. */
export function composeLabel(channel: Channel, detail?: string | null): string {
  const d = (detail ?? "").trim();
  return d ? `${channel} — ${d}` : channel;
}
