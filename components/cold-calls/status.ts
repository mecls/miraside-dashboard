/** Shared call-status styling for the Cold Calls table, pills, and drawer. */
export const STATUS_STYLE: Record<string, string> = {
  "Not called": "border-neutral-700 bg-neutral-500/10 text-neutral-400",
  Called: "border-neutral-600 bg-neutral-500/10 text-neutral-200",
  "No answer": "border-amber-500/30 bg-amber-500/10 text-amber-300",
  "Follow up": "border-violet-500/30 bg-violet-500/10 text-violet-300",
  "Meeting booked": "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  "Not interested": "border-rose-500/30 bg-rose-500/10 text-rose-300",
  "Not a fit": "border-rose-500/30 bg-rose-500/10 text-rose-300",
  "Invalid number": "border-rose-500/30 bg-rose-500/10 text-rose-300",
};
export const STATUS_DOT: Record<string, string> = {
  "Not called": "bg-neutral-500",
  Called: "bg-neutral-300",
  "No answer": "bg-amber-400",
  "Follow up": "bg-violet-400",
  "Meeting booked": "bg-emerald-400",
  "Not interested": "bg-rose-400",
  "Not a fit": "bg-rose-400",
  "Invalid number": "bg-rose-400",
};
export const statusStyle = (s: string) => STATUS_STYLE[s] || "border-sky-500/30 bg-sky-500/10 text-sky-300";
export const statusDot = (s: string) => STATUS_DOT[s] || "bg-sky-400";

export const KNOWN_REPS = ["Carvalhal", "Rolo"];
