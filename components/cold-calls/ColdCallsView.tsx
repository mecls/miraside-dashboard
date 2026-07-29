"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppSelect, type AppSelectOption } from "@/components/AppSelect";
import { Kpi, cn, BTN } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { CALL_STATUSES, type ColdCallRow } from "@/lib/cold-calls";
import { statusStyle, statusDot, KNOWN_REPS } from "./status";
import { ColdCallDrawer } from "./ColdCallDrawer";

const th = "px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500";
const td = "px-4 py-2.5 text-sm text-neutral-200";

const pctS = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) + "%" : "—");
const isAttempted = (c: ColdCallRow) => c.callStatus !== "Not called";
const isAnswered = (c: ColdCallRow) => isAttempted(c) && c.callStatus !== "No answer" && c.callStatus !== "Invalid number";
const isBooked = (c: ColdCallRow) => c.callStatus === "Meeting booked";

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function uniqueOptions(values: string[], allLabel: string): AppSelectOption[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [
    { value: "", label: allLabel },
    ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => ({ value: v, label: `${v} (${n})` })),
  ];
}

type DimKey = "niche" | "industry" | "industryGroup" | "companySize" | "seniority" | "assignedUser";
const DIMENSIONS: { key: DimKey; label: string }[] = [
  { key: "niche", label: "Niche" },
  { key: "industry", label: "Industry" },
  { key: "industryGroup", label: "Industry Group" },
  { key: "companySize", label: "Company Size" },
  { key: "seniority", label: "Seniority" },
  { key: "assignedUser", label: "Assigned rep" },
];

const PAGE = 100;
const UNASSIGN = "__unassign__"; // sentinel for the bulk "Unassign" option (distinct from the "" placeholder)

export function ColdCallsView({ contacts, syncedAt }: { contacts: ColdCallRow[]; syncedAt: string | null }) {
  const router = useRouter();
  const [view, setView] = useState<"contacts" | "analytics">("contacts");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [rep, setRep] = useState("");
  const [group, setGroup] = useState("");
  const [niche, setNiche] = useState("");
  const [size, setSize] = useState("");
  const [toCall, setToCall] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [dim, setDim] = useState<DimKey>("niche");
  const [selected, setSelected] = useState<ColdCallRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null); // anchor row for shift-click ranges
  const [bulkBusy, setBulkBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const reps = useMemo(
    () => [...new Set([...KNOWN_REPS, ...contacts.map((c) => c.assignedUser).filter(Boolean)])].sort(),
    [contacts]
  );

  const statusOpts = useMemo(() => uniqueOptions(contacts.map((c) => c.callStatus), "All statuses"), [contacts]);
  const repOpts = useMemo(() => uniqueOptions(contacts.map((c) => c.assignedUser), "All reps"), [contacts]);
  const groupOpts = useMemo(() => uniqueOptions(contacts.map((c) => c.industryGroup), "All industry groups"), [contacts]);
  const nicheOpts = useMemo(() => uniqueOptions(contacts.map((c) => c.niche), "All niches"), [contacts]);
  const sizeOpts = useMemo(() => uniqueOptions(contacts.map((c) => c.companySize), "All sizes"), [contacts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return contacts.filter((c) => {
      if (status && c.callStatus !== status) return false;
      if (rep && c.assignedUser !== rep) return false;
      if (group && c.industryGroup !== group) return false;
      if (niche && c.niche !== niche) return false;
      if (size && c.companySize !== size) return false;
      if (toCall && !(c.callStatus === "Not called" || c.callStatus === "Follow up")) return false;
      if (needle && !`${c.fullName} ${c.companyName} ${c.email} ${c.phone} ${c.role} ${c.niche}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [contacts, q, status, rep, group, niche, size, toCall]);

  const k = useMemo(() => {
    const total = filtered.length;
    const attempted = filtered.filter(isAttempted).length;
    const answered = filtered.filter(isAnswered).length;
    const booked = filtered.filter(isBooked).length;
    return { total, attempted, answered, booked, notCalled: total - attempted };
  }, [filtered]);

  const segments = useMemo(() => {
    const m = new Map<string, { contacts: number; attempted: number; answered: number; booked: number }>();
    for (const c of filtered) {
      const key = (c[dim] as string) || "—";
      const e = m.get(key) || { contacts: 0, attempted: 0, answered: 0, booked: 0 };
      e.contacts++;
      if (isAttempted(c)) e.attempted++;
      if (isAnswered(c)) e.answered++;
      if (isBooked(c)) e.booked++;
      m.set(key, e);
    }
    return [...m.entries()]
      .map(([label, v]) => ({ label, ...v, bookRate: v.attempted ? v.booked / v.attempted : 0 }))
      .sort((a, b) => b.booked - a.booked || b.bookRate - a.bookRate || b.attempted - a.attempted)
      .slice(0, 25);
  }, [filtered, dim]);

  const statusBreak = useMemo(() => {
    const order: string[] = [...CALL_STATUSES];
    const m = new Map<string, number>();
    for (const c of filtered) m.set(c.callStatus, (m.get(c.callStatus) || 0) + 1);
    for (const s of m.keys()) if (!order.includes(s)) order.push(s);
    const max = Math.max(1, ...[...m.values()]);
    return order.filter((s) => m.get(s)).map((s) => ({ status: s, n: m.get(s) || 0, max }));
  }, [filtered]);

  const visible = filtered.slice(0, limit);
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));

  // Drop any selected ids that no longer exist after a refresh (e.g. removed from the sheet).
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(contacts.map((c) => c.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [contacts]);

  // Header checkbox shows the "some but not all" indeterminate dash.
  useEffect(() => {
    const el = selectAllRef.current;
    if (el) el.indeterminate = selectedIds.size > 0 && !allFilteredSelected;
  }, [selectedIds, allFilteredSelected]);

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map((c) => c.id)) : new Set());
    setLastIndex(null);
  }

  function onRowCheck(index: number, id: string, shiftKey: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const [lo, hi] = [Math.min(lastIndex, index), Math.max(lastIndex, index)];
        for (let i = lo; i <= hi; i++) next.add(visible[i].id); // fill the whole range
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastIndex(index);
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setLastIndex(null);
  }

  async function bulkApply(patch: { callStatus?: string; assignedUser?: string }) {
    if (selectedIds.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const r = await fetch("/api/cold-calls/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds], ...patch }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Bulk update failed");
      const skipped = d.writeback?.skipped?.length ?? 0;
      toast(`Updated ${d.updated}${skipped ? ` · ${skipped} not written to sheet` : ""}`, skipped ? "error" : "success");
      clearSelection();
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Bulk update failed", "error");
    } finally {
      setBulkBusy(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      const r = await fetch("/api/cold-calls/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Sync failed");
      toast(`Synced — ${d.inserted} new, ${d.updated} updated${d.flaggedRemoved ? `, ${d.flaggedRemoved} removed` : ""}`, "success");
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync failed", "error");
    } finally {
      setSyncing(false);
    }
  }

  async function patchContact(id: string, body: Record<string, unknown>, msg: string) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/cold-calls/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Save failed");
      toast(d.writeback?.ok === false ? `${msg} (sheet not updated: ${d.writeback.note})` : msg, d.writeback?.ok === false ? "error" : "success");
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  const resetFilters = () => { setQ(""); setStatus(""); setRep(""); setGroup(""); setNiche(""); setSize(""); setToCall(false); setLimit(PAGE); };
  const syncBtn = (
    <button onClick={runSync} disabled={syncing} className={BTN.secondary}>
      {syncing ? "Syncing…" : "Sync now"}
    </button>
  );

  if (contacts.length === 0) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-800 p-10 text-center">
        <div className="text-sm text-neutral-300">No contacts yet.</div>
        <div className="max-w-md text-xs text-neutral-500">Pull your “Portugal Leads” sheet to import contacts and their current call status.</div>
        {syncBtn}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Contacts" value={k.total.toLocaleString()} />
        <Kpi label="Not called" value={k.notCalled.toLocaleString()} muted sub={pctS(k.notCalled, k.total) + " of list"} />
        <Kpi label="Called" value={k.attempted.toLocaleString()} sub={pctS(k.attempted, k.total) + " of list"} />
        <Kpi label="Answered" value={k.answered.toLocaleString()} sub={pctS(k.answered, k.attempted) + " of called"} />
        <Kpi label="Meetings booked" value={k.booked.toLocaleString()} tone={k.booked ? "good" : "neutral"} />
        <Kpi label="Booking rate" value={pctS(k.booked, k.attempted)} tone={k.booked ? "good" : "neutral"} sub="booked / called" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-900 p-0.5 text-xs">
          {(["contacts", "analytics"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded px-3 py-1.5 font-medium transition-colors", view === v ? "bg-surface-200 text-neutral-50" : "text-neutral-400 hover:text-neutral-200")}>
              {v === "contacts" ? "Contacts" : "What's working"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          {syncedAt && <span>synced {ago(syncedAt)}</span>}
          {syncBtn}
        </div>
      </div>

      {view === "contacts" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Search name, company, phone, email…" className="h-[34px] min-w-[220px] flex-1 rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20" />
            <AppSelect value={status} options={statusOpts} onChange={(v) => { setStatus(v); setLimit(PAGE); }} className="min-w-[150px]" />
            <AppSelect value={rep} options={repOpts} onChange={(v) => { setRep(v); setLimit(PAGE); }} className="min-w-[130px]" />
            <AppSelect value={group} options={groupOpts} onChange={(v) => { setGroup(v); setLimit(PAGE); }} className="min-w-[160px]" />
            <AppSelect value={niche} options={nicheOpts} onChange={(v) => { setNiche(v); setLimit(PAGE); }} className="min-w-[150px]" />
            <AppSelect value={size} options={sizeOpts} onChange={(v) => { setSize(v); setLimit(PAGE); }} className="min-w-[120px]" />
            <button onClick={() => { setToCall((t) => !t); setLimit(PAGE); }} className={cn("inline-flex h-[34px] items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors", toCall ? "border-accent/40 bg-accent/10 text-accent" : "border-neutral-700 bg-neutral-700/30 text-neutral-300 hover:border-neutral-600")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", toCall ? "bg-accent" : "bg-neutral-500")} />To call
            </button>
            {(q || status || rep || group || niche || size || toCall) && <button onClick={resetFilters} className={BTN.ghost}>Clear</button>}
          </div>

          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
              <span className="text-xs font-medium tabular-nums text-accent">{selectedIds.size} selected</span>
              {bulkBusy ? (
                <span className="text-xs text-neutral-400">Updating…</span>
              ) : (
                <>
                  <AppSelect
                    value=""
                    placeholder="Assign rep…"
                    options={[
                      { value: "", label: "Assign rep…" },
                      ...reps.map((r) => ({ value: r, label: r })),
                      { value: UNASSIGN, label: "Unassign" },
                    ]}
                    onChange={(v) => bulkApply({ assignedUser: v === UNASSIGN ? "" : v })}
                    className="h-8 min-w-[150px]"
                  />
                  <AppSelect
                    value=""
                    placeholder="Set status…"
                    options={[{ value: "", label: "Set status…" }, ...CALL_STATUSES.map((s) => ({ value: s, label: s, dot: statusDot(s) }))]}
                    onChange={(v) => bulkApply({ callStatus: v })}
                    className="h-8 min-w-[150px]"
                  />
                  <button onClick={clearSelection} className={BTN.ghost}>Clear</button>
                </>
              )}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
            <table className="min-w-full text-sm">
              <thead className="border-b border-neutral-800 bg-panel">
                <tr>
                  <th className={cn(th, "w-8 pl-5 pr-2")}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={(e) => toggleAll(e.target.checked)}
                      className="h-3.5 w-3.5 cursor-pointer accent-accent align-middle"
                      aria-label="Select all"
                    />
                  </th>
                  <th className={th}>Contact</th>
                  <th className={th}>Company</th>
                  <th className={th}>Industry / Niche</th>
                  <th className={th}>Phone</th>
                  <th className={th}>Status</th>
                  <th className={th}>Rep</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c, i) => (
                  <tr key={c.id} className={cn("group border-b border-neutral-800 last:border-0 hover:bg-surface-200/40", selectedIds.has(c.id) && "bg-accent/[0.06]", busyId === c.id && "opacity-60")}>
                    <td className={cn(td, "w-8 pl-5 pr-2")} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onClick={(e) => onRowCheck(i, c.id, e.shiftKey)}
                        onChange={() => {}}
                        className="h-3.5 w-3.5 cursor-pointer accent-accent align-middle"
                        aria-label={`Select ${c.fullName || "contact"}`}
                      />
                    </td>
                    <td className={td}>
                      <button onClick={() => setSelected(c)} className="text-left font-medium text-neutral-100 hover:text-accent">
                        {c.fullName || "—"}
                      </button>
                      <div className="text-xs text-neutral-500">{c.role || "—"}{c.seniority ? ` · ${c.seniority}` : ""}</div>
                    </td>
                    <td className={td}>
                      <div className="text-neutral-200">{c.companyShortName || c.companyName || "—"}</div>
                    </td>
                    <td className={td}>
                      <div className="text-neutral-300">{c.niche || c.industry || "—"}</div>
                      {c.industryGroup && <div className="text-xs text-neutral-600">{c.industryGroup}</div>}
                    </td>
                    <td className={td}>
                      {c.phone ? (
                        <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1.5 tabular-nums text-neutral-300 hover:text-accent">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-neutral-600 group-hover:text-accent" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                          {c.phone}
                        </a>
                      ) : "—"}
                    </td>
                    <td className={cn(td, "w-[160px]")} onClick={(e) => e.stopPropagation()}>
                      <AppSelect
                        value={c.callStatus}
                        options={CALL_STATUSES.map((s) => ({ value: s, label: s, dot: statusDot(s) }))}
                        onChange={(v) => patchContact(c.id, { callStatus: v }, "Status updated")}
                        disabled={busyId === c.id}
                        className="h-8 w-full"
                      />
                    </td>
                    <td className={cn(td, "w-[130px]")} onClick={(e) => e.stopPropagation()}>
                      <AppSelect
                        value={c.assignedUser}
                        options={[{ value: "", label: "—" }, ...reps.map((r) => ({ value: r, label: r }))]}
                        onChange={(v) => patchContact(c.id, { assignedUser: v }, "Assignment updated")}
                        disabled={busyId === c.id}
                        className="h-8 w-full"
                      />
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-neutral-500">No contacts match these filters.</td></tr>}
              </tbody>
            </table>
          </div>

          {filtered.length > visible.length && (
            <div className="flex justify-center">
              <button onClick={() => setLimit((l) => l + PAGE)} className={BTN.secondary}>Show {Math.min(PAGE, filtered.length - visible.length)} more</button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
            <div className="border-b border-neutral-800 px-4 py-2.5"><h3 className="mono-title">Call outcomes</h3></div>
            <div className="space-y-2 p-4">
              {statusBreak.map(({ status: s, n, max }) => (
                <div key={s} className="flex items-center gap-3">
                  <div className="w-32 shrink-0 text-xs text-neutral-400">{s}</div>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-neutral-800"><div className={cn("h-full rounded", statusDot(s))} style={{ width: `${(n / max) * 100}%`, opacity: 0.85 }} /></div>
                  <div className="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-300">{n}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-4 py-2.5">
              <h3 className="mono-title">What&apos;s working — ranked by meetings booked</h3>
              <div className="w-48"><AppSelect value={dim} options={DIMENSIONS.map((d) => ({ value: d.key, label: `By ${d.label}` }))} onChange={(v) => setDim(v as DimKey)} className="w-full" /></div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-neutral-800 bg-panel">
                  <tr>
                    <th className={cn(th, "pl-5")}>{DIMENSIONS.find((d) => d.key === dim)?.label}</th>
                    <th className={cn(th, "text-right")}>Contacts</th>
                    <th className={cn(th, "text-right")}>Called</th>
                    <th className={cn(th, "text-right")}>Answered</th>
                    <th className={cn(th, "text-right")}>Booked</th>
                    <th className={cn(th, "text-right")}>Book&nbsp;%</th>
                  </tr>
                </thead>
                <tbody>
                  {segments.map((s) => (
                    <tr key={s.label} className="border-b border-neutral-800 last:border-0 hover:bg-surface-200/40">
                      <td className={cn(td, "pl-5 text-neutral-200")}>{s.label}</td>
                      <td className={cn(td, "text-right tabular-nums text-neutral-400")}>{s.contacts}</td>
                      <td className={cn(td, "text-right tabular-nums text-neutral-300")}>{s.attempted}</td>
                      <td className={cn(td, "text-right tabular-nums text-neutral-300")}>{s.answered}</td>
                      <td className={cn(td, "text-right tabular-nums", s.booked ? "text-emerald-400" : "text-neutral-500")}>{s.booked}</td>
                      <td className={cn(td, "text-right tabular-nums", s.booked ? "text-emerald-400" : "text-neutral-500")}>{s.attempted ? pctS(s.booked, s.attempted) : "—"}</td>
                    </tr>
                  ))}
                  {segments.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-neutral-500">No data for this segment.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="border-t border-neutral-800 px-4 py-2 text-xs text-neutral-600">Book % = meetings booked ÷ contacts called.</div>
          </div>
        </div>
      )}

      {selected && (
        <ColdCallDrawer contact={selected} reps={reps} onClose={() => setSelected(null)} onChanged={() => router.refresh()} />
      )}
    </div>
  );
}
