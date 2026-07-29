"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { AppSelect } from "@/components/AppSelect";
import { toast } from "@/components/Toaster";
import { eur } from "@/lib/format";
import type { PipelineBoard, PipelineDeal } from "@/lib/pipeline";

/* Tonal badge recipes (DESIGN-SYSTEM.md): 10% fill, 30% border, 300 text. sky=meeting, violet=follow-up. */
const BADGE = "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";
const ROSE = "border-rose-500/30 bg-rose-500/10 text-rose-300";
const AMBER = "border-amber-500/30 bg-amber-500/10 text-amber-300";
const SKY = "border-sky-500/30 bg-sky-500/10 text-sky-300";
const EMERALD = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
const VIOLET = "border-violet-500/30 bg-violet-500/10 text-violet-300";
const NEUTRAL = "border-neutral-700 bg-neutral-500/10 text-neutral-400";

type CallStatus = { label: string; cls: string; dot: string };

/** What's happening on this deal's call, as one badge — reads the dashboard's own call data layered on
 *  the GHL stage. Priority: the queues that owe action first, then the meeting verdict, then call state. */
function deriveCall(d: PipelineDeal): CallStatus | null {
  if (d.needsRebook) return { label: "Needs rebook", cls: ROSE, dot: "bg-rose-400" };
  if (d.awaitingOutcome) return { label: "Awaiting outcome", cls: AMBER, dot: "bg-amber-400" };
  const att = d.apptAttendance ?? d.latestAttendance;
  if (att === "no_show") return { label: "No-show", cls: ROSE, dot: "bg-rose-400" };
  if (att === "cancelled") return { label: "Cancelled", cls: NEUTRAL, dot: "bg-neutral-500" };
  if (att === "showed") {
    if (d.latestOutcome === "won") return { label: "Won", cls: EMERALD, dot: "bg-emerald-400" };
    if (d.latestOutcome === "follow_up_booked") return { label: "Follow-up booked", cls: VIOLET, dot: "bg-violet-400" };
    if (d.latestOutcome === "proposal_sent") return { label: "Proposal sent", cls: SKY, dot: "bg-sky-400" };
    if (d.latestOutcome === "disqualified") return { label: "Disqualified", cls: ROSE, dot: "bg-rose-400" };
    return { label: "Showed", cls: EMERALD, dot: "bg-emerald-400" };
  }
  if (d.appointmentAt && new Date(d.appointmentAt).getTime() > Date.now()) {
    return d.latestConfirmedAt
      ? { label: "Confirmed", cls: SKY, dot: "bg-sky-400" }
      : { label: "Booked", cls: SKY, dot: "bg-sky-400" };
  }
  switch (d.callState) {
    case "no_answer": return { label: "No answer", cls: AMBER, dot: "bg-amber-400" };
    case "contacted": return { label: "Contacted", cls: NEUTRAL, dot: "bg-neutral-500" };
    case "follow_up": return { label: "Follow-up", cls: VIOLET, dot: "bg-violet-400" };
    case "invalid_phone": return { label: "Bad number", cls: ROSE, dot: "bg-rose-400" };
    case "meeting_booked": return { label: "Booked", cls: SKY, dot: "bg-sky-400" };
    default: return null;
  }
}

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return null;
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}h ago`;
  const m = Math.floor(ms / 60_000);
  return m >= 1 ? `${m}m ago` : "just now";
}

type FilterKey = "rebook" | "awaiting" | "upcoming" | "won";
function matchesFilter(d: PipelineDeal, f: FilterKey | null): boolean {
  if (!f) return true;
  if (f === "rebook") return d.needsRebook;
  if (f === "awaiting") return d.awaitingOutcome;
  if (f === "upcoming")
    return !!d.appointmentAt && new Date(d.appointmentAt).getTime() > Date.now() && !d.needsRebook && !d.awaitingOutcome;
  if (f === "won") return d.status === "won";
  return true;
}

export function PipelineView({ board }: { board: PipelineBoard }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [view, setView] = useState<"board" | "table">(params.get("view") === "table" ? "table" : "board");
  const [filter, setFilter] = useState<FilterKey | null>(null);
  const [deals, setDeals] = useState<PipelineDeal[]>(board.deals);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Server refetch (pipeline switch) hands down a fresh board — resync the optimistic copy.
  useEffect(() => setDeals(board.deals), [board]);

  const stages = board.pipeline?.stages ?? [];
  const stageOptions = useMemo(() => stages.map((s) => ({ value: s.id, label: s.name })), [stages]);

  function changeView(next: "board" | "table") {
    setView(next);
    const q = new URLSearchParams(Array.from(params.entries()));
    q.set("view", next);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }
  function changePipeline(id: string) {
    const q = new URLSearchParams(Array.from(params.entries()));
    q.set("pipeline", id);
    router.push(`${pathname}?${q.toString()}`, { scroll: false });
  }

  async function move(oppId: string, toStageId: string) {
    if (!board.pipeline) return;
    const stage = stages.find((s) => s.id === toStageId);
    const deal = deals.find((d) => d.oppId === oppId);
    if (!stage || !deal || deal.stageId === toStageId) return;
    const prev = deal.stageId;
    setDeals((ds) => ds.map((d) => (d.oppId === oppId ? { ...d, stageId: toStageId } : d)));
    try {
      const res = await fetch(`/api/pipeline/${oppId}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipelineId: board.pipeline.id, stageId: toStageId, stageName: stage.name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error ?? "Couldn't move the deal.");
      setDeals((ds) => ds.map((d) => (d.oppId === oppId ? { ...d, status: j.status ?? d.status } : d)));
      toast(`Moved ${deal.name} to ${stage.name}`);
    } catch (e) {
      setDeals((ds) => ds.map((d) => (d.oppId === oppId ? { ...d, stageId: prev } : d)));
      toast(e instanceof Error ? e.message : "Couldn't move the deal.", "error");
    }
  }

  // ----- states with nothing to render -----
  if (!board.configured) return <Empty title="GoHighLevel isn't connected." sub="Connect it in settings to mirror your sales pipeline here." />;
  if (!board.pipeline) return <Empty title="No pipeline found in GoHighLevel." sub="Create a sales pipeline in GHL and it will appear here." />;

  const counts = {
    rebook: deals.filter((d) => d.needsRebook).length,
    awaiting: deals.filter((d) => d.awaitingOutcome).length,
    upcoming: deals.filter((d) => matchesFilter(d, "upcoming")).length,
    won: deals.filter((d) => d.status === "won").length,
  };
  const shown = deals.filter((d) => matchesFilter(d, filter));

  const dupName = board.pipelines.filter((p) => p.name === board.pipeline!.name).length > 1;
  const pipelineOptions = board.pipelines.map((p) => ({
    value: p.id,
    label: dupName ? `${p.name} · ${p.stageCount} stages` : p.name,
  }));

  return (
    <div>
      {/* Toolbar: view toggle · pipeline picker · deal count */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-900 p-0.5">
            {(["board", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => changeView(v)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                  view === v ? "bg-surface-200 text-neutral-100" : "text-neutral-500 hover:text-neutral-200"
                )}
              >
                {v === "board" ? <IconBoard /> : <IconTable />}
                {v === "board" ? "Kanban" : "Table"}
              </button>
            ))}
          </div>
          {board.pipelines.length > 1 && (
            <AppSelect value={board.pipeline.id} options={pipelineOptions} onChange={changePipeline} className="h-8 min-w-[180px]" />
          )}
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">
          {shown.length}
          {filter ? ` of ${deals.length}` : ""} deal{shown.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Needs-action strip — the "which calls need doing" summary, doubles as a filter */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatFilter label="Needs rebook" n={counts.rebook} dot="bg-rose-400" active={filter === "rebook"} onClick={() => setFilter(filter === "rebook" ? null : "rebook")} />
        <StatFilter label="Awaiting outcome" n={counts.awaiting} dot="bg-amber-400" active={filter === "awaiting"} onClick={() => setFilter(filter === "awaiting" ? null : "awaiting")} />
        <StatFilter label="Upcoming" n={counts.upcoming} dot="bg-sky-400" active={filter === "upcoming"} onClick={() => setFilter(filter === "upcoming" ? null : "upcoming")} />
        <StatFilter label="Won" n={counts.won} dot="bg-emerald-400" active={filter === "won"} onClick={() => setFilter(filter === "won" ? null : "won")} />
      </div>

      {deals.length === 0 ? (
        <div className="mt-4">
          <Empty
            title="No deals in this pipeline yet."
            sub="Deals appear when a call is booked (your GoHighLevel workflow creates them). As bookings come in, they show up here automatically."
          />
        </div>
      ) : view === "board" ? (
        <Board stages={stages} deals={shown} dragOver={dragOver} setDragOver={setDragOver} onDrop={move} />
      ) : (
        <Table stages={stages} stageOptions={stageOptions} deals={shown} onMove={move} />
      )}
    </div>
  );
}

/* ---------------- Kanban ---------------- */
function Board({
  stages,
  deals,
  dragOver,
  setDragOver,
  onDrop,
}: {
  stages: { id: string; name: string }[];
  deals: PipelineDeal[];
  dragOver: string | null;
  setDragOver: Dispatch<SetStateAction<string | null>>;
  onDrop: (oppId: string, stageId: string) => void;
}) {
  const byStage = useMemo(() => {
    const m = new Map<string, PipelineDeal[]>();
    for (const s of stages) m.set(s.id, []);
    const orphan: PipelineDeal[] = [];
    for (const d of deals) {
      const arr = d.stageId ? m.get(d.stageId) : undefined;
      if (arr) arr.push(d);
      else orphan.push(d);
    }
    return { m, orphan };
  }, [stages, deals]);

  return (
    <div className="mt-4 flex gap-3 overflow-x-auto pb-3">
      {stages.map((s) => {
        const list = byStage.m.get(s.id) ?? [];
        const over = dragOver === s.id;
        return (
          <div
            key={s.id}
            onDragOver={(e) => { e.preventDefault(); setDragOver(s.id); }}
            onDragLeave={() => setDragOver((cur) => (cur === s.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              const oppId = e.dataTransfer.getData("text/plain");
              setDragOver(null);
              if (oppId) onDrop(oppId, s.id);
            }}
            className={cn(
              "flex w-[248px] shrink-0 flex-col rounded-lg border bg-neutral-900 transition-colors",
              over ? "border-accent/50 bg-surface-200/40" : "border-neutral-800"
            )}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
              <span className="truncate font-mono text-[11px] uppercase tracking-wider text-neutral-300">{s.name}</span>
              <span className="ml-2 shrink-0 rounded-full bg-surface-200 px-1.5 text-[11px] text-neutral-500">{list.length}</span>
            </div>
            <div className="flex min-h-[80px] flex-col gap-2 p-2">
              {list.map((d) => <DealCard key={d.oppId} d={d} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DealCard({ d }: { d: PipelineDeal }) {
  const call = deriveCall(d);
  const when = fmtWhen(d.appointmentAt);
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", d.oppId); e.dataTransfer.effectAllowed = "move"; }}
      className="group cursor-grab rounded-md border border-neutral-800 bg-neutral-950/40 p-2.5 shadow-xs transition-colors hover:border-neutral-700 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-neutral-100">{d.name}</div>
          {d.company && <div className="truncate text-xs text-neutral-500">{d.company}</div>}
        </div>
        {d.value != null && d.value > 0 && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-accent">{eur(d.value)}</span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {call && (
          <span className={cn(BADGE, call.cls)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", call.dot)} />
            {call.label}
          </span>
        )}
        {when && <span className="font-mono text-[10.5px] text-neutral-500">{when}</span>}
      </div>
      {(d.callAttempts ?? 0) > 0 || d.leadId ? (
        <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-neutral-600">
          {(d.callAttempts ?? 0) > 0 && <span>{d.callAttempts} call{d.callAttempts === 1 ? "" : "s"}</span>}
          {d.leadId && (
            <a href={`/leads?q=${encodeURIComponent(d.name)}`} className="text-neutral-500 hover:text-accent" onClick={(e) => e.stopPropagation()}>
              Open lead
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Table ---------------- */
function Table({
  stages,
  stageOptions,
  deals,
  onMove,
}: {
  stages: { id: string; name: string }[];
  stageOptions: { value: string; label: string }[];
  deals: PipelineDeal[];
  onMove: (oppId: string, stageId: string) => void;
}) {
  const stageName = (id: string | null) => stages.find((s) => s.id === id)?.name ?? "—";
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
      <table className="w-full min-w-[860px] border-collapse">
        <thead>
          <tr className="border-b border-neutral-800 bg-panel text-left font-mono text-[11px] uppercase tracking-wider text-neutral-500">
            <th className="py-2.5 pl-5 pr-4 font-normal">Contact</th>
            <th className="px-4 py-2.5 font-normal">Stage</th>
            <th className="px-4 py-2.5 font-normal">Call</th>
            <th className="px-4 py-2.5 font-normal">Next call</th>
            <th className="px-4 py-2.5 text-right font-normal">Value</th>
            <th className="px-4 py-2.5 pr-5 font-normal">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => {
            const call = deriveCall(d);
            return (
              <tr key={d.oppId} className="border-b border-neutral-800 text-sm last:border-0 hover:bg-surface-200/50">
                <td className="py-2.5 pl-5 pr-4">
                  <div className="text-neutral-100">
                    {d.leadId ? (
                      <a href={`/leads?q=${encodeURIComponent(d.name)}`} className="hover:text-accent">{d.name}</a>
                    ) : (
                      d.name
                    )}
                  </div>
                  {d.company && <div className="text-xs text-neutral-500">{d.company}</div>}
                </td>
                <td className="px-4 py-2.5">
                  <AppSelect value={d.stageId ?? ""} options={stageOptions} onChange={(id) => onMove(d.oppId, id)} placeholder={stageName(d.stageId)} className="h-8 min-w-[170px]" />
                </td>
                <td className="px-4 py-2.5">
                  {call ? (
                    <span className={cn(BADGE, call.cls)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", call.dot)} />
                      {call.label}
                    </span>
                  ) : (
                    <span className="text-neutral-600">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-neutral-300">{fmtWhen(d.appointmentAt) ?? <span className="text-neutral-600">—</span>}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {d.value != null && d.value > 0 ? <span className="text-neutral-100">{eur(d.value)}</span> : <span className="text-neutral-600">—</span>}
                </td>
                <td className="px-4 py-2.5 pr-5 text-neutral-500">{fmtAgo(d.updatedAt) ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- bits ---------------- */
function StatFilter({ label, n, dot, active, onClick }: { label: string; n: number; dot: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-2.5 text-left transition-colors",
        active ? "border-accent/50 bg-surface-200/50" : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
      )}
    >
      <div className="text-xl font-medium tabular-nums text-neutral-50">{n}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
        <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">{label}</span>
      </div>
    </button>
  );
}

function Empty({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-6 py-16 text-center shadow-xs">
      <p className="text-sm text-neutral-300">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-neutral-500">{sub}</p>
    </div>
  );
}

function IconBoard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
      <rect x="3" y="4" width="6" height="16" rx="1" /><rect x="14" y="4" width="6" height="10" rx="1" />
    </svg>
  );
}
function IconTable() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
      <path d="M3 5h18M3 12h18M3 19h18" strokeLinecap="round" />
    </svg>
  );
}
