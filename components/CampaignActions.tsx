"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "./ui";

export function CampaignActions({ dbId, status }: { dbId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [budget, setBudget] = useState("");

  async function act(action: string, extra: Record<string, any> = {}, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch("/api/ads/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbId, level: "campaign", action, ...extra }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error ?? "Action failed.");
      else router.refresh();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50";
  const isActive = status === "ACTIVE";
  const isArchived = status === "ARCHIVED";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isArchived &&
        (isActive ? (
          <button onClick={() => act("pause")} disabled={!!busy} className={cn(btn, "text-amber-300 hover:border-amber-500/50 hover:bg-amber-500/10")}>
            {busy === "pause" ? "…" : "Pause"}
          </button>
        ) : (
          <button
            onClick={() => act("resume", {}, "This campaign will start delivering and SPENDING. Continue?")}
            disabled={!!busy}
            className={cn(btn, "text-emerald-300 hover:border-emerald-500/50 hover:bg-emerald-500/10")}
          >
            {busy === "resume" ? "…" : "Resume"}
          </button>
        ))}

      {!isArchived && (
        <button
          onClick={() => act("archive", {}, "Archive this campaign? It stops and is hidden from active views.")}
          disabled={!!busy}
          className={cn(btn, "text-neutral-400 hover:bg-surface-200")}
        >
          {busy === "archive" ? "…" : "Archive"}
        </button>
      )}

      <span className={cn("text-[11px] font-medium", isActive ? "text-emerald-400" : isArchived ? "text-neutral-600" : "text-amber-400")}>
        {status.toLowerCase()}
      </span>

      {!isArchived && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-neutral-600">€/day</span>
          <input
            type="number"
            min={1}
            step={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="set"
            className="h-7 w-16 rounded-md border border-neutral-700 bg-surface-200 px-2 text-right text-xs tabular-nums text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
          />
          <button
            onClick={() => budget && act("budget", { dailyEur: Number(budget) })}
            disabled={!!busy || !budget}
            className={btn}
          >
            {busy === "budget" ? "…" : "Set"}
          </button>
        </span>
      )}

      {err && <span className="w-full text-[11px] text-rose-400">{err}</span>}
    </div>
  );
}
