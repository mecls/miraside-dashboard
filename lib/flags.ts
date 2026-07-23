import type { Settings } from "./queries";

export type FlagTone = "good" | "warn" | "danger" | "info" | "neutral";

export interface Flag {
  id: string; // D1, D4, ...
  label: string;
  tone: FlagTone;
  reason: string;
}

/** Inputs needed to evaluate the FB-derivable flags for one ad. */
export interface FlagInput {
  spend: number;
  frequency: number | null;
  cpl: number | null;
  gated: boolean;
  spendSharePct: number; // 0..100
  ctrPercentile: number | null; // 0..100, lower = worse CTR vs other ads
  ctrDeclinePct: number | null; // % below the trailing mean, null if insufficient
  fatigueWindowImpressions: number; // pooled impressions over the fatigue window
  reachGrowthPct: number | null; // null until multi-window reach is available
  cpmSpikeRatio: number | null; // currentCpm / trailing median, null if insufficient history
}

const n = (s: Settings, k: string, d: number) => Number(s[k] ?? d);

export const FREQ_TONE: Record<string, FlagTone> = {
  Prospecting: "good",
  "Mid-funnel": "warn",
  Retargeting: "warn",
};

/** Revenue/EMQ-dependent flags that can't fire until GHL (or EMQ) is connected. */
export const PENDING_FLAGS: { id: string; label: string; needs: string }[] = [
  { id: "D0", label: "Scale", needs: "revenue (GHL)" },
  { id: "D2", label: "Feeder — don't kill", needs: "revenue (GHL)" },
  { id: "D3", label: "Retargeting winner — don't scale", needs: "revenue (GHL)" },
  { id: "D10", label: "Kill / reallocate", needs: "revenue (GHL)" },
  { id: "D11", label: "EMQ / tracking health", needs: "Events Manager EMQ" },
];

export function computeFlags(a: FlagInput, s: Settings): Flag[] {
  const flags: Flag[] = [];
  const targetCpl = n(s, "target_cpl_eur", 10);
  const gate = n(s, "d12_spend_gate_multiple", 4) * targetCpl;

  // D12 — spend-before-judging gate
  if (a.gated) {
    flags.push({
      id: "D12",
      label: "Insufficient data",
      tone: "neutral",
      reason: `Spent €${a.spend.toFixed(2)} — below the €${gate.toFixed(0)} judging gate (${n(s, "d12_spend_gate_multiple", 4)}× target CPL).`,
    });
  }

  // D1 — frequency -> funnel position
  if (a.frequency != null) {
    const pm = n(s, "d1_freq_prospecting_max", 1.3);
    const rm = n(s, "d1_freq_retargeting_min", 2.0);
    if (a.frequency < pm) {
      flags.push({ id: "D1", label: "Prospecting", tone: "good", reason: `Frequency ${a.frequency.toFixed(2)} — fresh audience.` });
    } else if (a.frequency < rm) {
      flags.push({ id: "D1", label: "Mid-funnel", tone: "warn", reason: `Frequency ${a.frequency.toFixed(2)}.` });
    } else {
      flags.push({ id: "D1", label: "Retargeting", tone: "warn", reason: `Frequency ${a.frequency.toFixed(2)} — audience seeing it repeatedly.` });
    }
  }

  // D4 — creative fatigue
  if (a.frequency != null && a.frequency > n(s, "d4_freq_min", 3)) {
    const haveVolume = a.fatigueWindowImpressions >= n(s, "d4_min_impressions", 1000);
    if (haveVolume && a.ctrDeclinePct != null && a.ctrDeclinePct >= n(s, "d4_ctr_decline_pct", 25)) {
      flags.push({
        id: "D4",
        label: "Creative fatigue",
        tone: "danger",
        reason: `Freq ${a.frequency.toFixed(2)} and CTR down ${a.ctrDeclinePct.toFixed(0)}% vs its ${n(s, "d4_trailing_window_days", 7)}-day mean.`,
      });
    }
  }

  // D5 — audience saturation
  if (
    a.frequency != null &&
    a.frequency > n(s, "d5_freq_min", 4) &&
    a.reachGrowthPct != null &&
    a.reachGrowthPct < n(s, "d5_reach_growth_max_pct", 5)
  ) {
    flags.push({ id: "D5", label: "Audience saturation", tone: "warn", reason: `Freq ${a.frequency.toFixed(2)} and reach plateaued.` });
  }

  // D8 — CPM spike
  if (a.cpmSpikeRatio != null && a.cpmSpikeRatio > n(s, "d8_cpm_spike_multiple", 2)) {
    flags.push({ id: "D8", label: "CPM spike", tone: "warn", reason: `CPM ${a.cpmSpikeRatio.toFixed(1)}× its own recent median.` });
  }

  // D6 — niche pocket (needs a real CPL, so only past the gate)
  if (!a.gated && a.cpl != null) {
    const goodCost = a.cpl <= n(s, "d6_cpr_ratio_max", 1) * targetCpl;
    if (a.spendSharePct < n(s, "d6_spend_share_max_pct", 5) && goodCost) {
      flags.push({ id: "D6", label: "Niche pocket — leave on", tone: "good", reason: `Small spend, cost-per-lead on target.` });
    }
  }

  // D7 — soft-metric / result divergence
  if (!a.gated && a.cpl != null && a.ctrPercentile != null) {
    const badCtr = a.ctrPercentile <= n(s, "d7_ctr_percentile_max", 25);
    const goodResult = a.cpl <= n(s, "d7_cpr_ratio_max", 1) * targetCpl;
    if (badCtr && goodResult) {
      flags.push({ id: "D7", label: 'Don’t "fix" — result is good', tone: "info", reason: `Weak CTR but cost-per-lead is on target.` });
    }
  }

  return flags;
}
