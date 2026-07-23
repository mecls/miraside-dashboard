"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn, SectionLabel } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { ImageIcon, CopyIcon, LayersIcon, CarouselIcon, XIcon } from "./icons";
import { LaunchPreviewModal } from "./LaunchPreviewModal";
import { LaunchProgressModal } from "./LaunchProgressModal";
import type { LaunchRow } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// UTC-based so server and client render identically (no hydration mismatch).
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// The real state machine: DRAFT | LAUNCHING | PAUSED | PARTIAL | CANCELLED | FAILED (LIVE/PENDING were never written — C20).
// ACTIVE/MIXED aren't launch outcomes — they come from `liveStatus`, the sync's rollup of what the launch's
// ads are doing on Meta right now (see badgeFor).
const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  MIXED: "border border-sky-500/30 bg-sky-500/10 text-sky-300",
  PAUSED: "border border-amber-500/30 bg-amber-500/10 text-amber-300",
  PARTIAL: "border border-amber-500/30 bg-amber-500/10 text-amber-300",
  LAUNCHING: "border border-accent/30 bg-accent/10 text-accent",
  DRAFT: "border border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
  CANCELLED: "border border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
  FAILED: "border border-rose-500/30 bg-rose-500/10 text-rose-300",
};

/**
 * What the badge should say. A finished launch is always recorded as PAUSED (everything launches paused),
 * so once the sync knows what its ads are actually doing, show THAT instead — otherwise a launch you
 * switched on in Ads Manager reads "Paused" forever. In-flight/failed/draft states always win.
 */
function badgeFor(l: LaunchRow): string {
  const settled = l.status === "PAUSED" || l.status === "PARTIAL";
  if (settled && l.liveStatus) return l.liveStatus;
  return l.status;
}

const FORMAT_LABEL: Record<string, string> = {
  single: "Single",
  multi_ratio: "Multi-Ratio",
  flexible: "Flexible",
  carousel: "Carousel",
  duplicate: "Duplicate",
};

const FORMAT_ICON: Record<string, (p: { className?: string }) => React.ReactElement> = {
  single: ImageIcon,
  multi_ratio: CopyIcon,
  flexible: LayersIcon,
  carousel: CarouselIcon,
  duplicate: CopyIcon,
};

export function LaunchHistory({ launches, onResume, resuming }: { launches: LaunchRow[]; onResume?: (id: string) => void; resuming?: boolean }) {
  const router = useRouter();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  // A clicked row opens either the live progress popup (a launch in flight) or the image preview.
  const [open, setOpen] = useState<{ id: string; mode: "progress" | "preview" } | null>(null);
  const visible = launches.filter((l) => !removed.has(l.id));
  // Always resolve the freshest row by id so the progress popup reflects each 4s refresh, not a stale snapshot.
  const openRow = open ? launches.find((l) => l.id === open.id) ?? null : null;

  // A launch is running server-side — refresh so it flips from "Launching…" to "Paused" on its own.
  useEffect(() => {
    if (!launches.some((l) => l.status === "LAUNCHING")) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [launches, router]);

  // Stop an in-progress batched launch. Clears the queue so no more ads get created; anything already
  // created stays PAUSED on Meta. The entry drops back to a reopenable draft (if nothing launched yet).
  async function cancel(id: string) {
    if (cancelingId) return;
    if (!confirm("Cancel this launch? Any ads already created stay paused; the remaining ones won't be created.")) return;
    setCancelingId(id);
    try {
      const res = await fetch(`/api/launches/${id}/cancel`, { method: "POST" });
      if (!res.ok) { toast("Couldn't cancel", "error"); return; }
      router.refresh();
    } catch {
      toast("Couldn't cancel", "error");
    } finally {
      setCancelingId(null);
    }
  }

  // Delete a history entry — the record only; it never touches the live ads on Meta.
  async function del(id: string, isDraft: boolean) {
    if (deletingId) return;
    if (!confirm(isDraft ? "Delete this draft? Its saved creatives will be removed." : "Remove this from the launch history?")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/launches/${id}`, { method: "DELETE" });
      if (!res.ok) { toast("Couldn't delete", "error"); return; }
      setRemoved((s) => new Set(s).add(id));
      router.refresh();
    } catch {
      toast("Couldn't delete", "error");
    } finally {
      // Always clear it — otherwise the `if (deletingId) return` guard would block every later delete.
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-3">
      <SectionLabel>Launch history</SectionLabel>
      {visible.length === 0 ? (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-6 py-12 text-center text-sm text-neutral-500">
          No launches yet. Batches you launch will show up here with their status and format.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Format</th>
                <th className="px-4 py-3 text-right font-medium">Launched</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => {
                const Icon = (l.format && FORMAT_ICON[l.format]) || ImageIcon;
                const isDraft = l.status === "DRAFT";
                const canResume = isDraft && !!onResume;
                return (
                  <tr
                    key={l.id}
                    onClick={() => !resuming && setOpen({ id: l.id, mode: l.status === "LAUNCHING" ? "progress" : "preview" })}
                    className={cn(
                      "group cursor-pointer border-b border-neutral-800 transition-colors last:border-0 hover:bg-surface-200/50",
                      resuming && "opacity-60"
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <ThumbStack urls={l.thumbUrls} />
                        <div className="min-w-0">
                          <div className="font-medium text-neutral-200">{l.name}</div>
                          {l.lastError && <div className="mt-0.5 max-w-md text-[11px] leading-snug text-amber-400/90">⚠ Last attempt: {l.lastError}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        title={badgeFor(l) !== l.status ? `Live status of this launch's ${l.adCount} ad${l.adCount === 1 ? "" : "s"} on Meta` : undefined}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                          STATUS_STYLE[badgeFor(l)] ?? STATUS_STYLE.DRAFT
                        )}
                      >
                        {l.status === "LAUNCHING" && <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent/40 border-t-accent" />}
                        {l.status === "LAUNCHING" ? (l.totalAds ? `Launching ${l.adCount}/${l.totalAds}` : "Launching…") : badgeFor(l)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5" />
                        {l.format ? FORMAT_LABEL[l.format] ?? l.format : "—"}
                        {l.adCount ? ` · ${l.adCount}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-400">
                      <div className="flex items-center justify-end gap-1">
                        {canResume && (
                          <button
                            onClick={(e) => { e.stopPropagation(); if (!resuming) onResume!(l.id); }}
                            title="Open in the editor to launch"
                            className="inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2 text-[11px] font-medium text-neutral-300 opacity-0 transition hover:bg-surface-200 hover:text-neutral-100 focus:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                          >
                            {resuming && <span className="h-3 w-3 animate-spin rounded-full border border-accent/40 border-t-accent" />}
                            {resuming ? "Opening…" : "Open in editor →"}
                          </button>
                        )}
                        {l.status === "LAUNCHING" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); cancel(l.id); }}
                            title="Stop this launch"
                            className="inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2 text-[11px] font-medium text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 focus-visible:outline-none"
                          >
                            {cancelingId === l.id && <span className="h-3 w-3 animate-spin rounded-full border border-rose-400/40 border-t-rose-300" />}
                            {cancelingId === l.id ? "Cancelling…" : "Cancel"}
                          </button>
                        )}
                        <span className="tabular-nums">{fmtDate(l.launchedAt ?? l.createdAt)}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); del(l.id, isDraft); }}
                          aria-label="Delete from history"
                          title="Remove from history"
                          className="rounded p-1 text-neutral-600 opacity-0 transition-opacity hover:text-rose-400 focus:opacity-100 group-hover:opacity-100"
                        >
                          {deletingId === l.id ? (
                            <span className="block h-3.5 w-3.5 animate-spin rounded-full border border-neutral-600 border-t-neutral-300" />
                          ) : (
                            <XIcon className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {openRow && open && (open.mode === "progress" ? (
        <LaunchProgressModal launch={openRow} onClose={() => setOpen(null)} />
      ) : (
        <LaunchPreviewModal launch={openRow} onClose={() => setOpen(null)} />
      ))}
    </section>
  );
}

function ThumbStack({ urls }: { urls: string[] }) {
  const shown = urls.slice(0, 3);
  if (shown.length === 0) return <div className="h-9 w-9 rounded-md bg-neutral-800/80" />;
  return (
    <div className="flex -space-x-2">
      {shown.map((u, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} src={u} alt="" className="h-9 w-9 rounded-md object-cover ring-2 ring-neutral-900" />
      ))}
    </div>
  );
}
