"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "./ui";
import { toast } from "./Toaster";

/**
 * Ads-Manager-style on/off switch for a single campaign / ad set / ad.
 * The USER flips it; turning ON asks for confirmation (it can spend). Never auto-toggled.
 */
export function StatusToggle({
  dbId,
  level,
  status,
  size = "md",
}: {
  dbId: string;
  level: "ad" | "adset" | "campaign";
  status: string;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [st, setSt] = useState((status || "").toUpperCase());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-sync when the parent re-renders with a fresh status (e.g. after a bulk on/off refresh).
  useEffect(() => {
    setSt((status || "").toUpperCase());
  }, [status]);

  const archived = st === "ARCHIVED" || st === "DELETED";
  const on = st === "ACTIVE";
  const noun = level === "ad" ? "ad" : level === "adset" ? "ad set" : "campaign";

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (archived || busy) return;
    const action = on ? "pause" : "resume";
    if (!on && !confirm(`Turn this ${noun} ON? It will start delivering and SPENDING once its campaign and ad set are also on.`)) return;
    const prev = st;
    setBusy(true);
    setErr(null);
    setSt(on ? "PAUSED" : "ACTIVE"); // optimistic
    try {
      const res = await fetch("/api/ads/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbId, level, action }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setSt(prev);
        setErr(j.error ?? "Failed.");
      } else {
        toast(`${noun[0].toUpperCase()}${noun.slice(1)} turned ${on ? "off" : "on"}`);
        router.refresh();
      }
    } catch {
      setSt(prev);
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  if (archived) return <span className="text-[11px] text-neutral-400">archived</span>;

  const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knob = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const knobOn = size === "sm" ? "translate-x-4" : "translate-x-5";

  return (
    <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={toggle}
        title={on ? `Turn ${noun} off` : `Turn ${noun} on`}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
          track,
          on ? "bg-accent" : "bg-surface-200"
        )}
      >
        <span className={cn("inline-block transform rounded-full bg-white shadow transition-transform", knob, on ? knobOn : "translate-x-0.5")} />
      </button>
      {err && <span className="text-[11px] text-rose-400">{err}</span>}
    </span>
  );
}
