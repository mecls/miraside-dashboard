"use client";

import { useEffect, useState } from "react";
import { ModalCard } from "./adsetup/ModalCard";
import type { LaunchRow } from "./types";

// Kept in sync with lib/launch-batch.ts (do NOT import that module here — it references a server secret).
const BATCH_SIZE = 5;
const BATCH_INTERVAL_MS = 180_000;

function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function roughEta(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m <= 0) return "under a minute";
  if (m === 1) return "about a minute";
  return `about ${m} min`;
}

type StepState = "done" | "active" | "pending";
function Dot({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M4 10l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  if (state === "active") return <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />;
  return <span className="h-5 w-5 shrink-0 rounded-full border-2 border-neutral-700" />;
}

function Step({ state, label, detail }: { state: StepState; label: string; detail?: string }) {
  return (
    <div className="flex items-center gap-3">
      <Dot state={state} />
      <div className="min-w-0">
        <div className={state === "pending" ? "text-sm text-neutral-500" : "text-sm text-neutral-200"}>{label}</div>
        {detail && <div className="text-[11px] text-neutral-500">{detail}</div>}
      </div>
    </div>
  );
}

/**
 * Live progress popup for a batched launch. Reads the launch row (refreshed by the parent every few seconds)
 * and shows: an overall bar (ads created / total), the current phase (setting up → creating → cooling down),
 * a per-second countdown to the next batch, and a rough ETA. Everything runs server-side, so the user can
 * close this or the whole tab and it keeps going.
 */
export function LaunchProgressModal({ launch, onClose }: { launch: LaunchRow; onClose: () => void }) {
  // Tick every second so the countdown/ETA feel live between the parent's data refreshes.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Anchor the cooldown countdown to when THIS nextBatchAt first arrived on the client, and count down the
  // known interval from there — using only the client clock, so server/client clock skew can't distort it (C56).
  const [anchor, setAnchor] = useState<{ key: string | null | undefined; at: number }>(() => ({ key: launch.nextBatchAt, at: Date.now() }));
  useEffect(() => {
    if (launch.nextBatchAt !== anchor.key) setAnchor({ key: launch.nextBatchAt, at: Date.now() });
  }, [launch.nextBatchAt, anchor.key]);

  const status = launch.status;
  const running = status === "LAUNCHING";
  const total = launch.totalAds ?? null;
  const done = launch.adCount ?? 0;
  const preparing = running && done === 0; // batch 1 in flight: campaign + ad set + first ads
  const setupDone = done > 0 || status === "PAUSED" || status === "PARTIAL";
  // Terminal without success — stopped before finishing (a hard fail, a revert to draft, or a cancel).
  const failed = status === "FAILED" || status === "DRAFT" || status === "CANCELLED";

  const coolingMs = running && launch.nextBatchAt ? Math.max(0, BATCH_INTERVAL_MS - (now - anchor.at)) : 0;
  const cooling = running && done > 0 && coolingMs > 1500 && (total ? done < total : true);

  const pct = total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : done > 0 ? 100 : 0;
  const remaining = total != null ? Math.max(0, total - done) : null;
  const batchesLeft = remaining != null ? Math.ceil(remaining / BATCH_SIZE) : null;
  const etaMs = running && batchesLeft && batchesLeft > 0 ? Math.max(0, cooling ? coolingMs : 0) + Math.max(0, batchesLeft - (cooling ? 1 : 0)) * BATCH_INTERVAL_MS : 0;

  let phase: string;
  let tone: "run" | "ok" | "warn" | "muted" | "fail" = "run";
  if (status === "LAUNCHING") phase = preparing ? "Setting up your campaign & ad set…" : cooling ? `Waiting for Meta to cool down — next ${BATCH_SIZE} in ${mmss(coolingMs)}` : "Creating ads…";
  else if (status === "PAUSED") { phase = "Done — every ad created (all paused)"; tone = "ok"; }
  else if (status === "PARTIAL") { phase = `Stopped early — ${done}${total ? ` of ${total}` : ""} created (paused)`; tone = "warn"; }
  else if (status === "CANCELLED") { phase = "Launch cancelled — nothing more was created."; tone = "muted"; }
  else { phase = "Couldn't launch — nothing was created."; tone = "fail"; } // FAILED / reverted to DRAFT

  const toneClass = { run: "text-accent", ok: "text-emerald-300", warn: "text-amber-300", muted: "text-neutral-400", fail: "text-rose-300" }[tone];
  // Steps only spin while a launch is actually running; a stopped launch shows idle circles, not spinners.
  const setupState: StepState = setupDone ? "done" : running ? "active" : "pending";
  const adsState: StepState = done > 0 && total != null && done >= total ? "done" : running && setupDone ? "active" : "pending";

  return (
    <ModalCard
      title={launch.name}
      subtitle={running ? (total ? `${total} ads · batched launch` : "Launching…") : failed ? "Couldn't launch" : status === "PAUSED" ? "Complete" : status === "PARTIAL" ? "Partly launched" : status}
      onClose={onClose}
      width="max-w-lg"
      footer={<button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none">Close</button>}
    >
      <div className="space-y-6">
        {/* Headline: count + phase */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-2xl font-medium tabular-nums text-neutral-100">{/* font-medium per DS stat-value rule (C59) */}
              {done}
              {total != null && <span className="text-neutral-500"> / {total}</span>}
              <span className="ml-2 text-sm font-normal text-neutral-500">ads created</span>
            </div>
            {total != null && !preparing && <div className="text-sm tabular-nums text-neutral-400">{pct}%</div>}
          </div>
          {/* Progress bar (indeterminate while preparing; rose stub on a failure) */}
          <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
            {preparing ? (
              <div className="h-full w-full animate-pulse rounded-full bg-accent/40" />
            ) : failed && done === 0 ? (
              <div className="h-full w-full rounded-full bg-rose-500/30" />
            ) : (
              <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
            )}
          </div>
          <div className={`flex items-center gap-2 text-sm ${toneClass}`}>
            {running && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-current" />}
            <span>{phase}</span>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <Step state={setupState} label="Campaign" detail="the container your ads live in" />
          <Step state={setupState} label="Ad set" detail="targeting, budget & placements" />
          <Step
            state={adsState}
            label={`Ads${total != null ? ` (${done} of ${total})` : ""}`}
            detail={cooling ? `next batch of ${BATCH_SIZE} in ${mmss(coolingMs)}` : `created ${BATCH_SIZE} at a time to stay under Meta's rate limit`}
          />
        </div>

        {/* ETA */}
        {running && etaMs > 0 && (
          <div className="text-center text-xs text-neutral-400">Roughly {roughEta(etaMs)} remaining</div>
        )}
        {(failed || status === "PARTIAL") && launch.lastError && (
          <div className={`rounded-lg border px-3 py-2 text-xs leading-snug ${failed ? "border-rose-500/30 bg-rose-500/10 text-rose-200/90" : "border-amber-500/30 bg-amber-500/10 text-amber-300/90"}`}>
            <span className="font-medium">Why it stopped: </span>{launch.lastError}
          </div>
        )}
      </div>
    </ModalCard>
  );
}
