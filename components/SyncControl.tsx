"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toaster";
import { cn } from "./ui";

/** "synced 3m ago" from an ISO timestamp; degrades to "never synced" on null/garbage. */
function relTime(iso: string | null): string {
  if (!iso) return "never synced";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never synced";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return "synced just now";
  const m = Math.round(s / 60);
  if (m < 60) return `synced ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `synced ${h}h ago`;
  return `synced ${Math.round(h / 24)}d ago`;
}

/**
 * Sidebar "Refresh data" control. Shows how fresh the dashboard is ("synced Nm ago") and forces an
 * on-demand Meta pull on click — so a just-launched campaign or a new lead shows up without waiting for
 * the 30-min scheduler. The relative label re-computes every 30s and again whenever the server re-renders
 * the layout (router.refresh after a successful pull feeds a new lastSyncedAt back in as a prop).
 */
export function SyncControl({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Seed empty (deterministic across SSR + hydration — relTime reads Date.now(), which would mismatch); the
  // effect fills the live "synced Nm ago" text immediately on mount and then every 30s.
  const [label, setLabel] = useState("");

  useEffect(() => {
    setLabel(relTime(lastSyncedAt));
    const t = window.setInterval(() => setLabel(relTime(lastSyncedAt)), 30_000);
    return () => window.clearInterval(t);
  }, [lastSyncedAt]);

  async function refresh() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/sync/refresh", { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) throw new Error(j?.error && j.error !== "Sync failed" ? j.error : "");
      if (j.skipped) {
        // Not an error: refusing to read Meta mid-launch is the system protecting delivery. Styled as
        // a failure it read like something broke. Matches the Leads-tab Refresh.
        toast(j.note || "Refresh paused while a launch is running. Try again shortly.");
      } else {
        toast("Dashboard refreshed");
        router.refresh();
      }
    } catch (e: any) {
      toast(e?.message ? e.message : "Couldn't refresh — try again", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={refresh}
      disabled={busy}
      title="Pull the latest campaigns, spend and leads from Meta now"
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-400 transition-colors hover:bg-surface-200/60 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <span className="text-neutral-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={cn("h-4 w-4 shrink-0", busy && "animate-spin")}>
          <path d="M23 4v6h-6" />
          <path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span>{busy ? "Refreshing…" : "Refresh data"}</span>
        <span className="truncate text-[11px] text-neutral-600">{busy ? "pulling from Meta" : label}</span>
      </span>
    </button>
  );
}
