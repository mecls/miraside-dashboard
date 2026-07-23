import type { FreqBand } from "./queries";

export type Tone = "good" | "warn" | "bad" | "neutral";

/** Text colors — used for metric cells/values so good/bad reads at a glance. */
export const TEXT_TONE: Record<Tone, string> = {
  good: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-rose-400",
  neutral: "text-neutral-300",
};

/** CPL vs target: at/under target = good, up to 1.5x = warn, over = bad. Gated = neutral. */
export function cplTone(cpl: number | null, targetCpl: number, gated: boolean): Tone {
  if (gated || cpl == null) return "neutral";
  const r = cpl / targetCpl;
  if (r <= 1) return "good";
  if (r <= 1.5) return "warn";
  return "bad";
}

/** CTR is better higher: at/above benchmark = good, below half = bad, between = warn. */
export function ctrTone(ctr: number | null, benchmark: number): Tone {
  if (ctr == null) return "neutral";
  if (ctr >= benchmark) return "good";
  if (ctr < benchmark * 0.5) return "bad";
  return "warn";
}

/** Frequency band -> tone (fresh prospecting good; rising frequency = caution). */
export function freqTone(band: FreqBand | null): Tone {
  if (band === "prospecting") return "good";
  if (band === "mid") return "warn";
  if (band === "retargeting") return "warn"; // high frequency = caution, not failure
  return "neutral";
}
