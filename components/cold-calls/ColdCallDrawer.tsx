"use client";

import { useEffect, useState } from "react";
import { AppSelect } from "@/components/AppSelect";
import { BTN, INPUT, cn } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { CALL_STATUSES, LOG_OUTCOMES, type ColdCallRow, type ColdCallActivity } from "@/lib/cold-calls";
import { statusStyle, statusDot } from "./status";

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) =>
  children ? (
    <div className="flex gap-3 py-1 text-sm">
      <div className="w-24 shrink-0 text-xs text-neutral-500">{label}</div>
      <div className="min-w-0 flex-1 text-neutral-200">{children}</div>
    </div>
  ) : null;

export function ColdCallDrawer({
  contact,
  reps,
  onClose,
  onChanged,
}: {
  contact: ColdCallRow;
  reps: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [activities, setActivities] = useState<ColdCallActivity[] | null>(null);
  const [notes, setNotes] = useState(contact.notes);
  const [busy, setBusy] = useState(false);

  // Log-call form.
  const [outcome, setOutcome] = useState<string>("");
  const [reachedDM, setReachedDM] = useState(false);
  const [objection, setObjection] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [logNotes, setLogNotes] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  useEffect(() => {
    let live = true;
    fetch(`/api/cold-calls/${contact.id}/activities`)
      .then((r) => r.json())
      .then((d) => { if (live) setActivities(d.activities ?? []); })
      .catch(() => { if (live) setActivities([]); });
    return () => { live = false; };
  }, [contact.id]);

  async function patch(bodyObj: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/cold-calls/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Save failed");
      toast(d.writeback?.ok === false ? `${okMsg} (sheet not updated: ${d.writeback.note})` : okMsg, d.writeback?.ok === false ? "error" : "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function logCall() {
    if (!outcome) { toast("Pick an outcome first", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/cold-calls/${contact.id}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          disposition: outcome,
          reachedDecisionMaker: reachedDM,
          objection,
          nextStep,
          followUpAt: followUp || undefined,
          notes: logNotes,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Log failed");
      toast(d.writeback?.ok === false ? `Call logged (sheet not updated: ${d.writeback.note})` : "Call logged", d.writeback?.ok === false ? "error" : "success");
      setOutcome(""); setReachedDM(false); setObjection(""); setNextStep(""); setFollowUp(""); setLogNotes("");
      const a = await fetch(`/api/cold-calls/${contact.id}/activities`).then((x) => x.json());
      setActivities(a.activities ?? []);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Log failed", "error");
    } finally {
      setBusy(false);
    }
  }

  const repOptions = [{ value: "", label: "Unassigned" }, ...reps.map((r) => ({ value: r, label: r }))];
  const website = contact.website ? contact.website.replace(/^https?:\/\//, "") : "";

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-[460px] flex-col border-l border-neutral-800 bg-panel shadow-2xl">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-50">{contact.fullName || "—"}</div>
            <div className="truncate text-xs text-neutral-500">
              {[contact.role, contact.seniority].filter(Boolean).join(" · ")}
            </div>
            <div className="truncate text-xs text-neutral-400">{contact.companyName}</div>
          </div>
          <button onClick={onClose} className={BTN.ghost} aria-label="Close">✕</button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* quick edit */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mono-label mb-1">Status</div>
              <AppSelect
                value={contact.callStatus}
                options={CALL_STATUSES.map((s) => ({ value: s, label: s, dot: statusDot(s) }))}
                onChange={(v) => patch({ callStatus: v }, "Status updated")}
                className="w-full"
                disabled={busy}
              />
            </div>
            <div>
              <div className="mono-label mb-1">Assigned</div>
              <AppSelect
                value={contact.assignedUser}
                options={repOptions}
                onChange={(v) => patch({ assignedUser: v }, "Assignment updated")}
                className="w-full"
                disabled={busy}
              />
            </div>
          </div>

          {/* facts */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2">
            <Row label="Phone">
              {contact.phone ? <a href={`tel:${contact.phone}`} className="tabular-nums text-neutral-200 hover:text-accent">{contact.phone}</a> : null}
            </Row>
            <Row label="Email">{contact.email ? <a href={`mailto:${contact.email}`} className="hover:text-sky-400">{contact.email}</a> : null}</Row>
            <Row label="LinkedIn">{contact.personLinkedin ? <a href={contact.personLinkedin} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">Profile ↗</a> : null}</Row>
            <Row label="Website">{website ? <a href={`https://${website}`} target="_blank" rel="noreferrer" className="hover:text-sky-400">{website}</a> : null}</Row>
            <Row label="Industry">{[contact.niche, contact.industry].filter(Boolean).join(" · ")}</Row>
            <Row label="Segment">{[contact.industryGroup, contact.companySize && `${contact.companySize} emp`, contact.country].filter(Boolean).join(" · ")}</Row>
            <Row label="Attempts">{contact.attempts ? `${contact.attempts}${contact.lastAttemptAt ? ` · last ${fmt(contact.lastAttemptAt)}` : ""}` : null}</Row>
          </div>

          {/* log a call */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mono-title mb-3">Log a call</div>
            <div className="space-y-2">
              <AppSelect value={outcome} options={[{ value: "", label: "Outcome…" }, ...LOG_OUTCOMES.map((s) => ({ value: s, label: s, dot: statusDot(s) }))]} onChange={setOutcome} className="w-full" />
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input type="checkbox" checked={reachedDM} onChange={(e) => setReachedDM(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
                Reached the decision-maker
              </label>
              <input value={objection} onChange={(e) => setObjection(e.target.value)} placeholder="Objection (verbatim)…" className={cn(INPUT, "w-full")} />
              <input value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="Next step…" className={cn(INPUT, "w-full")} />
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-500">Follow-up</span>
                <input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className={cn(INPUT, "flex-1")} />
              </div>
              <textarea value={logNotes} onChange={(e) => setLogNotes(e.target.value)} placeholder="Call notes…" rows={2} className={cn(INPUT, "w-full resize-y py-2")} />
              <button onClick={logCall} disabled={busy} className={cn(BTN.primary, "w-full")}>Log call</button>
            </div>
          </div>

          {/* contact notes */}
          <div>
            <div className="mono-label mb-1">Notes (on contact)</div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={cn(INPUT, "w-full resize-y py-2")} placeholder="Persistent notes for this contact…" />
            <div className="mt-1 flex justify-end">
              <button onClick={() => patch({ notes }, "Notes saved")} disabled={busy || notes === contact.notes} className={BTN.secondary}>Save notes</button>
            </div>
          </div>

          {/* history */}
          <div>
            <div className="mono-label mb-2">Call history</div>
            {activities === null ? (
              <div className="text-xs text-neutral-600">Loading…</div>
            ) : activities.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-800 p-4 text-center text-xs text-neutral-500">No calls logged yet.</div>
            ) : (
              <ol className="space-y-2">
                {activities.map((a) => (
                  <li key={a.id} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", statusStyle(a.disposition))}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(a.disposition))} />{a.disposition || "—"}
                      </span>
                      <span className="text-xs text-neutral-500">{fmt(a.calledAt)}</span>
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {[a.rep && `by ${a.rep}`, a.reachedDecisionMaker === true && "reached DM", a.channel !== "call" && a.channel].filter(Boolean).join(" · ")}
                    </div>
                    {a.objection && <div className="mt-1 text-xs text-neutral-400">Objection: “{a.objection}”</div>}
                    {a.nextStep && <div className="text-xs text-neutral-400">Next: {a.nextStep}</div>}
                    {a.notes && <div className="mt-0.5 text-xs text-neutral-300">{a.notes}</div>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
