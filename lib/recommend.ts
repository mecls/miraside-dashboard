import type { AdPerf } from "./queries";

/** A plain-English next-step for one ad, derived from its flags + gate state. */
export function recommend(a: AdPerf, spendGate: number, targetCpl: number): string {
  if (a.gated) {
    const need = Math.max(0, spendGate - a.spend);
    return `Hold — not enough spend to judge yet. Give it about €${need.toFixed(0)} more (the judging gate is €${spendGate.toFixed(
      0
    )}). Frequency is ${a.frequency != null ? a.frequency.toFixed(2) : "—"}${a.freqBand ? ` (${a.freqBand})` : ""}.`;
  }
  const d4 = a.flags.find((f) => f.id === "D4");
  if (d4) return `Refresh the creative — ${d4.reason}`;
  const d8 = a.flags.find((f) => f.id === "D8");
  if (d8) return `Watch delivery — ${d8.reason}`;
  const d6 = a.flags.find((f) => f.id === "D6");
  if (d6) return "Leave it on — small but efficient pocket.";
  if (a.cpl != null) {
    return a.cpl <= targetCpl
      ? `On target — €${a.cpl.toFixed(2)} per lead (≤ €${targetCpl.toFixed(0)}). A scale verdict needs revenue (connect GHL).`
      : `Above target — €${a.cpl.toFixed(2)} per lead (> €${targetCpl.toFixed(0)}). A kill verdict needs revenue (connect GHL).`;
  }
  // Past the judging gate but ZERO leads — this is a problem, not "running normally" (N-recommend).
  if (a.leads === 0) {
    return `Investigate — spent €${a.spend.toFixed(0)} past the €${spendGate.toFixed(0)} judging gate with no leads. Check the offer / landing page / form.`;
  }
  return "Running normally.";
}
