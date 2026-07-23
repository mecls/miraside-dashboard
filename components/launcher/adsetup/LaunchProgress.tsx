"use client";

import { cn } from "@/components/ui";

export type LaunchStage = "upload" | "build" | "done";

const STAGES: { key: LaunchStage; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "build", label: "Build" },
  { key: "done", label: "Done" },
];

/** A staged launch progress bar: Upload (media) → Build (creating on Meta) → Done. */
export function LaunchProgress({ stage, uploadDone, uploadTotal, count }: { stage: LaunchStage; uploadDone: number; uploadTotal: number; count: number }) {
  const idx = stage === "done" ? 2 : stage === "build" ? 1 : 0;
  const pct =
    stage === "done" ? 100 : stage === "build" ? 70 : uploadTotal > 0 ? 5 + Math.round((uploadDone / uploadTotal) * 35) : 33;
  const label =
    stage === "done"
      ? "Done"
      : stage === "build"
        ? `Creating ${count} ad${count === 1 ? "" : "s"}`
        : uploadTotal > 0
          ? `Uploading media ${uploadDone}/${uploadTotal}`
          : "Preparing";

  return (
    <div className="w-full max-w-sm">
      <div className="mb-2 flex justify-between text-[11px]">
        {STAGES.map((s, i) => (
          <span key={s.key} className={cn(i <= idx ? "font-medium text-accent" : "text-neutral-600")}>
            {s.label}
          </span>
        ))}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div className="h-full rounded-full bg-accent transition-all duration-500 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2.5 flex items-center justify-center gap-2 text-xs text-neutral-300">
        {stage !== "done" && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />}
        {label}
      </div>
    </div>
  );
}
