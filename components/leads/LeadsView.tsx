"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn, Chip, Kpi, TONE_STYLE } from "@/components/ui";
import { AdThumb } from "@/components/AdLightbox";
import { AppSelect } from "@/components/AppSelect";
import { toast } from "@/components/Toaster";
import type { LeadView, Qualification, CallState } from "@/lib/leads";
import { eur } from "@/lib/format";
import { LEADS_COLS, leadsTableMinWidth } from "@/lib/leads-layout";
import { telHref, waHref } from "@/lib/phone-links";
import { WA_TEMPLATES, pickTemplate, renderTemplate, templateBody, firstName, type TemplateKey } from "@/lib/whatsapp-templates";
import {
  ATTENDANCE,
  ATTENDANCE_STYLE,
  ATTENDANCE_DOT,
  outcomesFor,
  DISQUALIFY_REASONS,
  needsRebooking,
  awaitingOutcome,
  rescheduleUrl,
  followUpBookingUrl,
  type LeadMeeting,
} from "@/lib/meetings";
import { DayPicker } from "react-day-picker";

/** Safety net for legacy slugged answers (new leads arrive resolved to the form's real text server-side):
 *  numeric ranges get their separator back ("2_9" → "2-9"); other underscores become spaces. */
function prettyAnswer(v: string): string {
  if (!v || !v.includes("_")) return v;
  const range = v.match(/^(\d+)_(\d+)$/);
  if (range) return `${range[1]}-${range[2]}`;
  const s = v.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  // Current-year dates drop the year — horizontal space is precious in the 7-column CRM row.
  // 24-hour time: shorter than "08:56 AM" (so it fits the Submitted column) and the format Miguel
  // reads natively (PT). Keeps the timestamp from spilling over the Call column.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Compact elapsed-time badge: "3h", "2d", "5w". For the lead-age cue on uncalled rows. */
function ageShort(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/** "21 Jul · 10:00" — the booked-call chip's compact stamp. */
function fmtAppt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} · ${time}`;
}

/** Meeting day/time as a person would say them in a message — "quarta, 23 de julho" · "10:30". */
function fmtApptDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-PT", { weekday: "long", day: "numeric", month: "long" });
}
function fmtApptTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** WhatsApp glyph — the official mark's silhouette, drawn as a filled path so it reads at 12px. */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.87 9.87 0 0 0 4.74 1.21h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.25 8.24a8.22 8.22 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.25 8.25-8.25zM8.53 7.33c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1s.9 2.43 1.03 2.6c.13.17 1.77 2.71 4.3 3.8.6.26 1.07.41 1.43.53.6.19 1.15.16 1.58.1.48-.07 1.49-.61 1.7-1.2.21-.59.21-1.09.15-1.2-.06-.1-.23-.16-.48-.29-.25-.12-1.49-.73-1.72-.82-.23-.08-.4-.12-.57.13-.17.25-.65.82-.8.99-.14.17-.29.19-.54.06-.25-.12-1.06-.39-2.02-1.24-.75-.67-1.25-1.49-1.4-1.74-.14-.25-.01-.38.11-.51.11-.11.25-.29.37-.44.13-.14.17-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.56-1.35-.77-1.85-.2-.48-.4-.42-.55-.42-.14-.01-.31-.01-.47-.01z" />
    </svg>
  );
}

function NoteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="13" y2="13" />
    </svg>
  );
}

/** "20 Jul, 14:15" — a note's timestamp (24h, matching the rest of the tab). */
function fmtNoteDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Mon, 21 Jul · 10:00–10:30" — the expanded row's full meeting stamp. */
function fmtApptRange(startIso: string, endIso: string | null): string {
  const s = new Date(startIso);
  if (isNaN(s.getTime())) return "—";
  const day = s.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const e = endIso ? new Date(endIso) : null;
  return `${day} · ${t(s)}${e && !isNaN(e.getTime()) ? `–${t(e)}` : ""}`;
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

/** Booked-call chip in the Meeting column. Its colour + dot carry the attendance verdict, so a no-show,
 *  a showed call, a cancelled one and a passed-but-unruled call read apart at a glance (before, every
 *  booking was the same sky chip, only muted once past). */
/** GREYSCALE by design (Miguel, 2026-07-23): the old per-state hues (sky/emerald/rose/amber pills)
 *  made the Meeting column the loudest thing on the table and states still read as confusing. Now every
 *  chip is a quiet neutral pill — a still-upcoming call is simply brighter than anything already in the
 *  past — and the ONLY colour left is a small amber dot on the two "you owe an action" states (confirm
 *  the call / record whether they showed), matching the app's amber-means-act convention. Details
 *  (showed / no-show / cancelled) live in the tooltip and the click-popover, not in hues. */
function ApptChip({ at, status, title, attendance, needsConfirm = false, needsRebook = false }: { at: string; status: string | null; title: string | null; attendance: "scheduled" | "showed" | "no_show" | "cancelled" | null; needsConfirm?: boolean; needsRebook?: boolean }) {
  const past = new Date(at).getTime() < Date.now();
  // Amber "did they show?" only AFTER the in-progress grace — a call that started 5 minutes ago is
  // presumed still happening, not awaiting a verdict (same rule as lib/meetings.awaitingOutcome).
  const awaiting = attendance === "scheduled" && new Date(at).getTime() + 45 * 60_000 < Date.now();
  const upcoming = attendance === "scheduled" && !past;
  const tone = upcoming || awaiting
    ? "border-neutral-600 bg-surface-200 text-neutral-100"
    : "border-neutral-700 bg-surface-200 text-neutral-500";
  const stateWord =
    attendance === "showed" ? "showed" : attendance === "no_show" ? "no-show" : attendance === "cancelled" ? "cancelled" : awaiting ? "awaiting outcome" : upcoming ? "upcoming" : null;
  // Dot grading (Miguel, 2026-07-23): AMBER = confirm the call / record the outcome; RED = they
  // no-showed and still owe a rebook attempt (clears once rebooked or disqualified). Red outranks.
  const rebookDot = needsRebook && attendance === "no_show";
  const actionDot = awaiting || needsConfirm;
  return (
    <span
      // Raw GHL status dropped from the tooltip: its default "confirmed" sat next to "needs day-before
      // confirmation" and read as a contradiction (different concepts, same word).
      title={[title ?? "Call booked", stateWord ? `— ${stateWord}` : null, needsConfirm ? "— needs day-before confirmation" : null, rebookDot ? "— call them to rebook" : null].filter(Boolean).join(" ")}
      // Fixed width (fills the Meeting column's usable 128px) so every chip is the same length — the
      // ragged per-date widths read as visual noise (Miguel, 2026-07-23).
      className={cn("inline-flex h-7 w-[128px] items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-medium tabular-nums", tone)}
    >
      {rebookDot ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
      ) : actionDot ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
      ) : (
        <CalendarIcon className="h-3 w-3" />
      )}
      {fmtAppt(at)}
    </span>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/**
 * Which section of the daily work queue a lead belongs to. The Tasks tab is grouped by these so the
 * list reads as "what do I owe, and when" instead of one undifferentiated run of rows — an overdue
 * promise and something due next month used to look identical.
 *
 * `rank` is the display/sort order. Never-called leads sit third: after commitments already broken or
 * due today, but ahead of anything that isn't due yet — a fresh paid lead beats next week's callback.
 */
/** The day-before confirmation surfaces from the START of the day before the call, so it sits on that
 *  whole day's Tasks list — the touch itself is done between lunch and 18:00 (Miguel's rule for
 *  preventing no-shows), but he plans the day in the morning and must SEE it then. Operator-local clock. */
function confirmWindowOpen(startsAt: string, now = Date.now()): boolean {
  const w = new Date(startsAt);
  if (isNaN(w.getTime())) return false;
  w.setDate(w.getDate() - 1);
  w.setHours(0, 0, 0, 0);
  return now >= w.getTime();
}
/** True while this lead's upcoming call still owes its day-before confirmation: scheduled, in the
 *  future, not yet ticked, and we're inside/past the window start. Drives the "Confirm tomorrow's call"
 *  queue section and the amber dot on the Meeting pill. */
function leadNeedsConfirmation(l: LeadView, now = Date.now()): boolean {
  // Judge the MIRRORED meeting when we can identify it (apptAttendance) — latest-by-time can name a
  // different (cancelled) meeting and both hid a due confirmation and dressed the chip wrongly.
  const att = l.apptAttendance ?? l.latestAttendance;
  const confirmedAt = l.apptAttendance != null ? l.apptConfirmedAt : l.latestConfirmedAt;
  if (!l.appointmentAt || att !== "scheduled" || confirmedAt) return false;
  const start = new Date(l.appointmentAt).getTime();
  if (isNaN(start) || start <= now) return false;
  return confirmWindowOpen(l.appointmentAt, now);
}

type QueueKey = "rebook" | "awaiting" | "confirm" | "overdue" | "today" | "firstcall" | "week" | "later";
const QUEUE_SECTIONS: { key: QueueKey; label: string; hint: string; tone: string }[] = [
  { key: "rebook", label: "Missed — rebook", hint: "booked, then no-showed or cancelled", tone: "text-rose-300" },
  { key: "awaiting", label: "Awaiting outcome", hint: "the call has passed — did they show?", tone: "text-amber-300" },
  { key: "confirm", label: "Confirm tomorrow's call", hint: "confirm with the lead by 18:00 the day before", tone: "text-amber-300" },
  { key: "overdue", label: "Overdue", hint: "past their due date", tone: "text-rose-300" },
  { key: "today", label: "Today", hint: "due today", tone: "text-amber-300" },
  { key: "firstcall", label: "Needs first call", hint: "never dialled", tone: "text-amber-300" },
  { key: "week", label: "This week", hint: "due within 7 days", tone: "text-neutral-300" },
  { key: "later", label: "Later", hint: "further out or undated", tone: "text-neutral-400" },
];
function queueBucket(l: LeadView): { key: QueueKey; rank: number } {
  const at = (k: QueueKey) => ({ key: k, rank: QUEUE_SECTIONS.findIndex((s) => s.key === k) });
  // Someone who booked and then didn't turn up is the most valuable lead in the pipeline — they were
  // interested enough to take a slot. They outrank everything, including an overdue reminder.
  if (l.needsRebook) return at("rebook");
  // A booked call that has come and gone but nobody has ruled on: keep it visible until someone records
  // whether they showed, or the most valuable lead silently leaves every queue.
  if (l.awaitingOutcome) return at("awaiting");
  // Tomorrow's call that nobody has confirmed yet — the day-before touch that prevents no-shows.
  if (leadNeedsConfirmation(l)) return at("confirm");
  // A lead with an open reminder is judged on that reminder, even if it was never dialled — the
  // reminder is the more specific commitment.
  if (!l.taskId) return at("firstcall");
  const tone = dueInfo(l.taskDueAt).tone;
  if (tone === "overdue") return at("overdue");
  if (tone === "today") return at("today");
  if (l.taskDueAt) {
    const d = new Date(l.taskDueAt).getTime();
    if (!isNaN(d) && d < Date.now() + 7 * 86_400_000) return at("week");
  }
  return at("later");
}

/**
 * "Leads synced Nm ago". Ticks every 30s without a re-fetch, and seeds empty on the first client render
 * so the server HTML and the client agree (a relative time rendered on the server is stale by the time
 * it hydrates, which React reports as a mismatch).
 */
function FreshnessChip({ syncedAt, busy }: { syncedAt: string | null; busy: boolean }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    const compute = () => {
      if (!syncedAt) return setLabel("not synced yet");
      const ms = Date.now() - new Date(syncedAt).getTime();
      if (isNaN(ms)) return setLabel("not synced yet");
      const min = Math.floor(ms / 60_000);
      if (min < 1) return setLabel("synced just now");
      if (min < 60) return setLabel(`synced ${min}m ago`);
      const h = Math.floor(min / 60);
      if (h < 24) return setLabel(`synced ${h}h ago`);
      return setLabel(`synced ${Math.floor(h / 24)}d ago`);
    };
    compute();
    const t = window.setInterval(compute, 30_000);
    return () => window.clearInterval(t);
  }, [syncedAt]);
  if (!label) return null;
  // Amber past an hour: the schedulers run every 30 min, so an hour without a sync means something is
  // wrong rather than merely quiet.
  const stale = !!syncedAt && Date.now() - new Date(syncedAt).getTime() > 60 * 60_000;
  return (
    <span
      title={syncedAt ? `Leads last pulled from Meta and GoHighLevel at ${fmtDate(syncedAt)}` : "No full lead sync has completed yet — the next one runs within 30 minutes"}
      className={cn("whitespace-nowrap text-xs tabular-nums", busy ? "text-neutral-500" : stale ? "text-amber-400/80" : "text-neutral-500")}
    >
      {busy ? "syncing…" : label}
    </span>
  );
}

/** Due-date bucket for a task: overdue (rose), due today (amber), later (neutral). */
function dueInfo(dueIso: string | null): { label: string; tone: "overdue" | "today" | "later" } {
  if (!dueIso) return { label: "no date", tone: "later" };
  const d = new Date(dueIso);
  if (isNaN(d.getTime())) return { label: "no date", tone: "later" };
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return { label: "today", tone: "today" };
  const label = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return d.getTime() < now.getTime() ? { label, tone: "overdue" } : { label, tone: "later" };
}

const TASK_TONE = {
  overdue: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  today: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  later: "border-neutral-800 bg-surface-200 text-neutral-400",
} as const;
const TASK_ICON_TONE = { overdue: "text-rose-400", today: "text-amber-400", later: "text-neutral-500" } as const;

/** Open-task chip beside the lead's name — the next task, when it's due, and how many more are open. */
function TaskChip({ title, dueAt, extra = 0 }: { title: string; dueAt: string | null; extra?: number }) {
  const due = dueInfo(dueAt);
  return (
    <span
      title={`${title} — due ${due.label}${extra > 0 ? ` (+${extra} more open task${extra === 1 ? "" : "s"})` : ""}`}
      className={cn("inline-flex h-5 max-w-[210px] items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] font-medium", TASK_TONE[due.tone])}
    >
      <ClockIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{title}</span>
      <span className="shrink-0 opacity-80">· {due.label}</span>
      {extra > 0 && <span className="shrink-0 opacity-70">+{extra}</span>}
    </span>
  );
}

/**
 * Transient one-line prompt floated under an anchor. Fixed positioning for the same reason as
 * CallSelect: the table's overflow container would clip an absolutely-positioned child on the last
 * row. Closes on Esc / scroll / resize / outside click.
 */
function FloatingPrompt({ anchor, onClose, children, bodyClassName = "flex items-center gap-1.5 px-2 py-1.5", excludeAnchor = false }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; bodyClassName?: string; excludeAnchor?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Whether a width-measured placement has happened yet — the box stays invisible until it has, so the
  // horizontal clamp is applied before the first VISIBLE frame (no off-screen flash on a narrow phone).
  const placedRef = useRef(false);
  // Layout effect: position is set before the browser paints, so the prompt never flashes unplaced.
  useLayoutEffect(() => {
    // Unlike the dropdown menus (which CLOSE on scroll — standard menu behavior), this prompt is an
    // offer the operator hasn't answered: scrolling the table sideways must not dismiss it. Re-anchor
    // on every scroll/resize instead, so it stays glued to its call cell.
    const place = () => {
      const r = anchor.getBoundingClientRect();
      // Clamp horizontally so a fixed-width popup (the 360px notes list) can't render off the right edge
      // of a phone. The box width is only known AFTER it mounts, so the first pass runs unmeasured and the
      // box stays hidden (placedRef); the rAF re-places with the real width and reveals it — one hidden
      // frame instead of a visible off-screen flash.
      const margin = 8;
      const bw = boxRef.current?.offsetWidth ?? 0;
      const bh = boxRef.current?.offsetHeight ?? 0;
      if (bw) placedRef.current = true;
      const left = bw ? Math.max(margin, Math.min(r.left, window.innerWidth - bw - margin)) : r.left;
      // Same clamp vertically: a tall popup (the meeting-outcome editor) opened on the LAST row must not
      // extend below the viewport, where its lower buttons would be unreachable (fixed position — no
      // amount of page scrolling brings them into view).
      const top = bh ? Math.max(margin, Math.min(r.bottom + 6, window.innerHeight - bh - margin)) : r.bottom + 6;
      setPos({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place); // re-place once the box has a measured width, so the clamp applies
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { anchor.focus?.(); onClose(); } }; // return focus to the trigger
    const outside = (e: globalThis.MouseEvent) => {
      // excludeAnchor: a click on the anchor (a toggle button) isn't "outside" — let its own onClick
      // handle the toggle instead of this closing then the click reopening.
      if (boxRef.current && !boxRef.current.contains(e.target as Node) && !(excludeAnchor && anchor.contains(e.target as Node))) onClose();
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", outside);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", outside);
    };
  }, [anchor, onClose, excludeAnchor]);
  if (!pos) return null;
  return (
    <div
      ref={boxRef}
      style={{ top: pos.top, left: pos.left, maxWidth: "calc(100vw - 16px)", visibility: placedRef.current ? "visible" : "hidden" }}
      className={cn("fixed z-30 rounded-md border border-[#333333] bg-surface-200 shadow-lg", bodyClassName)}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Caret pointing at the call cell — visually ties the prompt to its row. */}
      <span aria-hidden className="absolute -top-[5px] left-4 h-2 w-2 rotate-45 border-l border-t border-[#333333] bg-surface-200" />
      {children}
    </div>
  );
}

const PROMPT_BTN =
  "inline-flex h-6 items-center rounded-md border border-neutral-700 bg-surface-200 px-2 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100 disabled:opacity-50";

const toISODate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Inline manual task form (expanded row): title + due date, saved as a GHL contact task. */
function AddTaskForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (title: string, due: Date) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("Call again");
  const [date, setDate] = useState(() => toISODate(new Date(Date.now() + 86_400_000)));
  const [showCal, setShowCal] = useState(false);
  const selected = new Date(`${date}T00:00:00`);
  // One-tap due dates, matching the reschedule popover so the create and reschedule surfaces read the same.
  const quickPicks = (() => {
    const base = new Date();
    const mk = (offset: number) => { const d = new Date(base); d.setDate(base.getDate() + offset); return toISODate(d); };
    return [
      { label: "Today", value: mk(0) },
      { label: "Tomorrow", value: mk(1) },
      { label: "Monday", value: mk(((8 - base.getDay()) % 7) || 7) },
    ];
  })();
  return (
    <div className="mt-1">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {quickPicks.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={busy}
            onClick={() => { setDate(p.value); setShowCal(false); }}
            className={cn(
              "inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-50",
              date === p.value ? "border-accent/50 bg-accent/10 text-accent" : "border-neutral-700 bg-surface-200 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          placeholder="Task"
          className="h-7 w-44 rounded-md border border-neutral-700 bg-surface-200 px-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
        {/* Date trigger — opens the same react-day-picker calendar as the Ads Manager "Custom range".
            Rendered inline (below), so it just grows the panel: no overflow-clip / positioning hacks. */}
        <button
          type="button"
          disabled={busy}
          aria-expanded={showCal}
          onClick={() => setShowCal((s) => !s)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border bg-surface-200 px-2 text-sm transition-colors disabled:opacity-50",
            showCal ? "border-neutral-500 text-neutral-100" : "border-neutral-700 text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
          )}
        >
          <CalendarIcon className="h-3.5 w-3.5 text-neutral-500" />
          {selected.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
        </button>
        <button
          type="button"
          className={PROMPT_BTN}
          disabled={busy || !title.trim() || !date}
          onClick={() => {
            const d = new Date(`${date}T00:00:00`);
            d.setHours(10, 0, 0, 0);
            onSubmit(title.trim(), d);
          }}
        >
          Add
        </button>
        <button type="button" className="text-xs text-neutral-400 transition-colors hover:text-neutral-200" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {showCal && (
        <div className="mt-2 inline-block rounded-md border border-neutral-700 bg-neutral-900 p-2 shadow-lg">
          <DayPicker
            mode="single"
            weekStartsOn={1}
            selected={selected}
            defaultMonth={selected}
            disabled={{ before: (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })() }}
            onSelect={(d) => { if (d) setDate(toISODate(d)); setShowCal(false); }}
          />
        </div>
      )}
    </div>
  );
}

type Note = { id: string; body: string; createdAt: string | null };

/**
 * Contact notes (call log / reference), in the expanded panel. Notes are GHL native Notes — the source
 * of truth — fetched lazily when this mounts (i.e. when the row is opened), so they never touch the sync.
 */
/**
 * The lead's call history — one card per booked meeting, newest first, each recording what happened.
 *
 * Two layers, because "did they turn up" and "where are they in the pipeline" are different facts and
 * a single dropdown would force one to erase the other:
 *   ATTENDANCE — upcoming / showed / no-show / cancelled. GoHighLevel's own vocabulary, written back
 *     there so the CRM calendar stays honest for anyone not looking at this dashboard.
 *   OUTCOME — follow-up booked / proposal sent / won / disqualified (+ why). Ours alone; only offered
 *     once someone actually showed, since none of it can be true otherwise.
 *
 * Lazy-loaded on expand, exactly like the notes, so it never touches the 30-minute sync.
 */
function MeetingsSection({ leadId, lead, onSaved }: { leadId: string; lead?: LeadView; onSaved: (note: string | null) => void }) {
  const followUpUrl = lead ? followUpUrlFor(lead) : null;
  const [meetings, setMeetings] = useState<LeadMeeting[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Tracked separately from "no meetings": a failed load must NOT render as "this lead never booked".
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setMeetings(null);
    fetch(`/api/leads/${leadId}/meetings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setMeetings(Array.isArray(d.meetings) ? d.meetings : []); })
      .catch(() => { if (alive) { setMeetings([]); setFailed(true); setErr("Couldn't load the call history."); } });
    return () => { alive = false; };
  }, [leadId]);

  const attLabel = (v: string | null) => ATTENDANCE.find((a) => a.value === v)?.label ?? v ?? "";
  const outLabel = (v: string | null, att: LeadMeeting["attendance"]) =>
    outcomesFor(att).find((o) => o.value === v)?.label ?? v ?? "";

  // Best-effort local flip so the card responds instantly (the server response reconciles it right after).
  // Mirrors the server's own tidy-ups: an attendance change that strands the outcome clears it, and a
  // non-disqualify outcome clears the reason — so the optimistic state never shows a contradictory combo.
  function optimistic(m: LeadMeeting, patch: Record<string, unknown>): LeadMeeting {
    const next: LeadMeeting = { ...m };
    if ("attendance" in patch) {
      next.attendance = patch.attendance as LeadMeeting["attendance"];
      if (!("outcome" in patch) && !outcomesFor(next.attendance).some((o) => o.value === next.outcome)) {
        next.outcome = null;
        next.disqualifyReason = null;
      }
    }
    if ("outcome" in patch) {
      next.outcome = patch.outcome as LeadMeeting["outcome"];
      if (patch.outcome !== "disqualified") next.disqualifyReason = null;
    }
    if ("disqualifyReason" in patch) next.disqualifyReason = patch.disqualifyReason as LeadMeeting["disqualifyReason"];
    if ("notes" in patch) next.notes = (patch.notes as string | null) ?? null;
    if ("confirmed" in patch) next.confirmedAt = patch.confirmed ? new Date().toISOString() : null;
    return next;
  }

  // Undo for the two consequential, easy-to-mis-fire moves: clearing an outcome (a toggle-off that can
  // silently drop a lead back into the rebook queue) and any attendance change (it writes to the GHL
  // calendar). Same shape as the qualification-clear undo elsewhere in the tab.
  function offerUndo(meetingId: string, before: LeadMeeting, patch: Record<string, unknown>) {
    if ("outcome" in patch && patch.outcome == null && before.outcome) {
      toast(`Outcome cleared (was ${outLabel(before.outcome, before.attendance)})`, "success", {
        actionLabel: "Undo",
        duration: 8000,
        // Restore the reason too — undo must be a full revert, never a partial one.
        onAction: () => void save(meetingId, { outcome: before.outcome, disqualifyReason: before.disqualifyReason }, { silent: true }),
      });
      return;
    }
    if ("attendance" in patch && before.attendance !== patch.attendance) {
      toast(`Marked ${attLabel(patch.attendance as string)}`, "success", {
        actionLabel: "Undo",
        duration: 8000,
        // An attendance change can strand the outcome (server + optimistic both clear it), so restore the
        // FULL prior state — otherwise Undo silently drops the outcome/reason the change removed.
        onAction: () => void save(meetingId, { attendance: before.attendance, outcome: before.outcome, disqualifyReason: before.disqualifyReason }, { silent: true }),
      });
    }
  }

  async function save(meetingId: string, patch: Record<string, unknown>, opts?: { silent?: boolean }) {
    const before = (meetings ?? []).find((m) => m.id === meetingId) ?? null;
    setBusy(meetingId);
    setErr(null);
    setFailed(false);
    // Flip immediately, like every sibling call-state button, instead of lagging the full round trip.
    if (before) setMeetings((cur) => (cur ?? []).map((m) => (m.id === meetingId ? optimistic(m, patch) : m)));
    try {
      const res = await fetch(`/api/leads/${leadId}/meetings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId, ...patch }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d?.error ?? "failed");
      setMeetings((cur) => (cur ?? []).map((m) => (m.id === meetingId ? (d.meeting as LeadMeeting) : m)));
      // A GHL warning is a partial failure — the operator needs to know the CRM didn't take it.
      if (d.ghlWarning) toast(d.ghlWarning, "error");
      // Attendance AND outcome drive the queues: recording an outcome is the ONLY way a lead leaves the
      // "Missed — rebook" queue, so a change to either must refresh the parent table.
      if ("attendance" in patch || "outcome" in patch || "confirmed" in patch) onSaved(null);
      if (before && !opts?.silent) offerUndo(meetingId, before, patch);
    } catch (e) {
      // Roll the optimistic flip back to exactly what was there before.
      if (before) setMeetings((cur) => (cur ?? []).map((m) => (m.id === meetingId ? before : m)));
      setErr(e instanceof Error && e.message !== "failed" ? e.message : "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  // Hide the section only when we KNOW there are no bookings. A load failure still renders, so the
  // operator sees the error instead of silently concluding the lead has never booked a call.
  if (!failed && meetings !== null && meetings.length === 0) return null;

  // The "needs rebooking" / "did they show?" prompts speak to CURRENT owed work, so only the LATEST
  // meeting shows them — an older miss since superseded by a newer booking is history, not a to-do.
  const latestMeetingId =
    meetings && meetings.length ? meetings.reduce((a, b) => (new Date(b.startsAt).getTime() > new Date(a.startsAt).getTime() ? b : a)).id : null;

  return (
    <div className="mt-4 border-t border-neutral-800 pt-3">
      <p className="mono-label">Calls</p>
      {err && <p className="mt-1 text-xs text-rose-400">{err}</p>}
      {meetings === null ? (
        <p className="mt-2 text-xs text-neutral-600">Loading…</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {meetings.map((m) => {
            const disabled = busy === m.id;
            return (
              <div key={m.id} className="rounded-md border border-neutral-800 bg-surface-100 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs tabular-nums text-neutral-200">{fmtAppt(m.startsAt)}</span>
                  {m.title && <span className="truncate text-xs text-neutral-500" title={m.title}>{m.title}</span>}
                  {m.link && (
                    <a
                      href={m.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-neutral-500 transition-colors hover:text-neutral-200"
                      title="Open the meeting link"
                    >
                      ↗
                    </a>
                  )}
                  {/* GHL's own reschedule page: opens the booking calendar with this slot loaded — pick a
                      new time and it's done; the calendar sync mirrors the move back within a cycle. */}
                  {rescheduleUrl(m) && (
                    <a
                      href={rescheduleUrl(m)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="ml-auto text-xs text-sky-300/80 transition-colors hover:text-sky-200"
                      title="Open GoHighLevel's reschedule page for this call"
                    >
                      Reschedule ↗
                    </a>
                  )}
                </div>
                {/* Attendance + outcome + disqualify controls — shared with the Meeting-column pill's quick
                    popover (MeetingChipButton) so both surfaces stay identical. */}
                <div className="mt-2">
                  <MeetingControls meeting={m} disabled={disabled} followUpUrl={followUpUrl} onSave={(patch) => void save(m.id, patch)} />
                </div>
                <MeetingNote
                  value={m.notes}
                  disabled={disabled}
                  emphasize={m.outcome === "disqualified" && m.disqualifyReason === "other"}
                  onSave={(notes) => void save(m.id, { notes: notes || null })}
                />
                {/* A missed call is the most valuable lead in the pipeline — say so, and say what's owed. */}
                {m.id === latestMeetingId && needsRebooking(m) && (
                  <p className="mt-2 text-[11px] text-rose-300/80">
                    Needs rebooking — record an outcome once you&apos;ve reached them again.
                  </p>
                )}
                {m.id === latestMeetingId && awaitingOutcome(m) && (
                  <p className="mt-2 text-[11px] text-amber-300/80">This call has passed — did they show?</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Deal value on the lead's GHL opportunity — shown only for leads with a booking (the deal is created
 * by Miguel's GHL workflow when the call gets booked). The dashboard writes the value THROUGH GHL
 * (source of truth); a 409 means the workflow hasn't created the deal yet, which is a state, not an error.
 */
function OpportunitySection({ lead, onPatched }: { lead: LeadView; onPatched: (patch: Partial<LeadView>) => void }) {
  const [value, setValue] = useState<number | null>(lead.opportunityValue);
  const [status, setStatus] = useState<string | null>(lead.opportunityStatus);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [noOpp, setNoOpp] = useState(false);

  // A fresh sync/patch can move the lead's stored value under us — follow it unless mid-edit/save.
  // Ref-guarded and deliberately NOT keyed on `editing`: with `editing` in the deps, closing the input
  // fired this with the still-stale prop and instantly clobbered the optimistic value (review find).
  const holdRef = useRef(false);
  holdRef.current = editing || busy;
  useEffect(() => {
    if (!holdRef.current) {
      setValue(lead.opportunityValue);
      setStatus(lead.opportunityStatus);
    }
  }, [lead.opportunityValue, lead.opportunityStatus]);

  async function commit() {
    const n = Number(draft.replace(",", "."));
    setEditing(false);
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0 || n === (value ?? -1)) return;
    const before = value;
    setBusy(true);
    setValue(n); // optimistic — rolled back on failure
    try {
      const res = await fetch(`/api/leads/${lead.id}/opportunity`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueEur: n }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setValue(before);
        setNoOpp(true);
        return;
      }
      if (!res.ok) throw new Error(d?.error ?? "failed");
      const saved = typeof d.value === "number" ? d.value : n;
      const savedStatus = d.status ? String(d.status) : status;
      setValue(saved);
      setStatus(savedStatus);
      setNoOpp(false);
      // Patch the parent overlay (same mechanism as the task/tag saves): without it, collapsing and
      // re-expanding the row remounts this section from the stale list and the value visually reverts.
      onPatched({
        ghlOpportunityId: typeof d.opportunityId === "string" ? d.opportunityId : lead.ghlOpportunityId,
        opportunityValue: saved,
        opportunityStatus: savedStatus,
      });
      toast("Deal value saved to GoHighLevel", "success");
    } catch (e) {
      setValue(before);
      toast(e instanceof Error && e.message !== "failed" ? e.message : "Couldn't save the value.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-neutral-800 pt-3">
      <p className="mono-label">Deal</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editing ? (
          <input
            autoFocus
            inputMode="decimal"
            placeholder="0"
            className={`${EDIT_INPUT_CLASS} max-w-[120px]`}
            defaultValue={value ?? ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="group inline-flex items-center gap-1.5 text-sm text-neutral-100 transition-colors hover:text-white disabled:opacity-50"
            disabled={busy}
            title="Set the deal value (saved to the GoHighLevel opportunity)"
            onClick={() => {
              setDraft(value == null ? "" : String(value));
              setEditing(true);
            }}
          >
            <span className="tabular-nums">{value == null ? "Set value" : eur(value, value % 1 ? 2 : 0)}</span>
            <PencilIcon className="h-3 w-3 text-neutral-600 transition-colors group-hover:text-neutral-300" />
          </button>
        )}
        {status === "won" && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
            Won
          </span>
        )}
        {status === "lost" && (
          <span className="inline-flex items-center rounded-md border border-neutral-700 bg-surface-200 px-2 py-0.5 text-xs text-neutral-400">
            Lost
          </span>
        )}
      </div>
      {noOpp && (
        <p className="mt-1.5 text-[11px] text-neutral-500">
          No GoHighLevel opportunity for this contact yet. It&apos;s created when a meeting gets booked; try again in a moment.
        </p>
      )}
    </div>
  );
}

/** The attendance + outcome + disqualify buttons for ONE meeting. Presentational — `onSave(patch)` does
 *  the persist. Shared by the expanded-row history (MeetingsSection) and the Meeting-column pill popover
 *  so the two surfaces can never drift. */
/** Prefilled follow-up booking link for one lead: operator-corrected name split when present, else the
 *  effective full name split on its first space; effective (override-aware) email + phone. */
function followUpUrlFor(lead: LeadView): string {
  const full = (lead.fullName ?? "").trim();
  const parts = full ? full.split(/\s+/) : [];
  return followUpBookingUrl({
    firstName: lead.firstNameOverride ?? (parts[0] || null),
    lastName: lead.lastNameOverride ?? (parts.slice(1).join(" ") || null),
    email: lead.email,
    phone: lead.phone,
  });
}

function MeetingControls({
  meeting: m,
  disabled,
  onSave,
  followUpUrl,
}: {
  meeting: LeadMeeting;
  disabled: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  /** Prefilled Follow-up-Call booking link — renders the "Book follow-up" action after a showed call. */
  followUpUrl?: string | null;
}) {
  return (
    <>
      {/* Day-before confirmation — the pre-call touch that prevents no-shows. Only meaningful while the
          call is still ahead. Amber dot = the confirmation window is open (noon the day before onwards). */}
      {m.attendance === "scheduled" && new Date(m.startsAt).getTime() > Date.now() && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            title="Confirm the call with the lead the day before — between lunch and 18:00"
            onClick={(e) => { e.stopPropagation(); onSave({ confirmed: !m.confirmedAt }); }}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-50",
              m.confirmedAt
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-neutral-700 bg-surface-200 text-neutral-500 hover:text-neutral-200"
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", m.confirmedAt ? "bg-emerald-400" : confirmWindowOpen(m.startsAt) ? "bg-amber-400" : "bg-neutral-700")} />
            {m.confirmedAt ? "Confirmed" : "Confirm call"}
          </button>
        </div>
      )}
      {/* Layer 1 — did it happen. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ATTENDANCE.map((a) => (
          <button
            key={a.value}
            type="button"
            disabled={disabled}
            title={a.hint}
            onClick={(e) => { e.stopPropagation(); onSave({ attendance: a.value }); }}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-50",
              m.attendance === a.value ? ATTENDANCE_STYLE[a.value] : "border-neutral-700 bg-surface-200 text-neutral-500 hover:text-neutral-200"
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", m.attendance === a.value ? ATTENDANCE_DOT[a.value] : "bg-neutral-700")} />
            {a.label}
          </button>
        ))}
      </div>
      {/* Layer 2 — what came of it. The option set narrows with attendance; it MUST render for
          no-show/cancelled since recording an outcome is the only way a lead leaves the rebook queue. */}
      {outcomesFor(m.attendance).length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {outcomesFor(m.attendance).map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              title={o.hint}
              onClick={(e) => { e.stopPropagation(); onSave({ outcome: m.outcome === o.value ? null : o.value }); }}
              className={cn(
                "inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-50",
                m.outcome === o.value
                  ? o.value === "disqualified"
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                    : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-neutral-700 bg-surface-200 text-neutral-500 hover:text-neutral-200"
              )}
            >
              {o.label}
            </button>
          ))}
          {/* One-click follow-up: opens the Follow-up-Call calendar with the lead's details already
              filled (pick a slot, done) AND records the outcome — the booking and the bookkeeping are
              the same motion. Only after a SHOWED call: that's when a follow-up is the next step
              (a missed call is a reschedule of the same booking, not a new one). */}
          {m.attendance === "showed" && followUpUrl && (
            <button
              type="button"
              disabled={disabled}
              title="Open the Follow-up Call calendar with this lead's details pre-filled, and mark the outcome as Follow-up booked"
              onClick={(e) => {
                e.stopPropagation();
                window.open(followUpUrl, "_blank", "noopener,noreferrer");
                if (m.outcome !== "follow_up_booked") onSave({ outcome: "follow_up_booked" });
              }}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
            >
              Book follow-up ↗
            </button>
          )}
        </div>
      )}
      {m.outcome === "disqualified" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-neutral-600">Why</span>
          {DISQUALIFY_REASONS.map((d) => (
            <button
              key={d.value}
              type="button"
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); onSave({ disqualifyReason: d.value }); }}
              className={cn(
                "inline-flex h-6 items-center rounded-md border px-2 text-xs transition-colors disabled:opacity-50",
                m.disqualifyReason === d.value ? "border-rose-500/40 bg-rose-500/10 text-rose-300" : "border-neutral-700 bg-surface-200 text-neutral-500 hover:text-neutral-200"
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Lazy-loaded quick editor for a lead's LATEST meeting — the popover behind the Meeting-column pill, so
 *  attendance/outcome can be set without expanding the whole row. Fetches the meetings once on open,
 *  operates on the most recent one, and refreshes the row when a change moves the queue or the pill tone. */
function MeetingOutcomeQuick({ leadId, followUpUrl, onSaved }: { leadId: string; followUpUrl?: string | null; onSaved: (note: string | null) => void }) {
  const [meeting, setMeeting] = useState<LeadMeeting | null | undefined>(undefined); // undefined = still loading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/leads/${leadId}/meetings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        const list: LeadMeeting[] = Array.isArray(d.meetings) ? d.meetings : [];
        setMeeting(list.length ? list.reduce((a, b) => (new Date(b.startsAt).getTime() > new Date(a.startsAt).getTime() ? b : a)) : null);
      })
      .catch(() => { if (alive) { setMeeting(null); setErr("Couldn't load the call."); } });
    return () => { alive = false; };
  }, [leadId]);

  async function save(patch: Record<string, unknown>) {
    if (!meeting) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/meetings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId: meeting.id, ...patch }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d?.error ?? "failed");
      setMeeting(d.meeting as LeadMeeting);
      if (d.ghlWarning) toast(d.ghlWarning, "error");
      // Attendance/outcome move the queue AND the pill's own colour, so refresh the row.
      if ("attendance" in patch || "outcome" in patch || "confirmed" in patch) onSaved(null);
    } catch (e) {
      setErr(e instanceof Error && e.message !== "failed" ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  if (meeting === undefined) return <p className="px-1 py-1 text-xs text-neutral-500">Loading…</p>;
  if (!meeting) return <p className="px-1 py-1 text-xs text-neutral-500">{err ?? "No call on record."}</p>;
  return (
    <div className="w-full" onClick={(e) => e.stopPropagation()}>
      <p className="mb-1.5 text-[11px] text-neutral-400">{fmtAppt(meeting.startsAt)} — what happened?</p>
      <MeetingControls meeting={meeting} disabled={busy} followUpUrl={followUpUrl} onSave={save} />
      {/* Straight into GHL's reschedule page for this booking — the fast path for moving a call (or
          rebooking a no-show) without leaving the pill. */}
      {rescheduleUrl(meeting) && (
        <a
          href={rescheduleUrl(meeting)!}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-sky-300/80 transition-colors hover:text-sky-200"
          title="Open GoHighLevel's reschedule page for this call"
        >
          Reschedule in the booking calendar ↗
        </a>
      )}
      {err && <p className="mt-1.5 text-[11px] text-rose-400">{err}</p>}
    </div>
  );
}

/** The Meeting-column chip, as a button: click it to record attendance/outcome for the booked call in a
 *  small popover, instead of expanding the whole row. */
function MeetingChipButton({ lead, onSaved }: { lead: LeadView; onSaved: (note: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Click to record what happened on this call"
        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <ApptChip at={lead.appointmentAt!} status={lead.appointmentStatus} title={lead.appointmentTitle} attendance={lead.apptAttendance ?? lead.latestAttendance} needsConfirm={leadNeedsConfirmation(lead)} needsRebook={lead.needsRebook} />
      </button>
      {open && ref.current && (
        <FloatingPrompt anchor={ref.current} onClose={() => setOpen(false)} excludeAnchor bodyClassName="p-2 w-[252px]">
          <MeetingOutcomeQuick leadId={lead.id} followUpUrl={followUpUrlFor(lead)} onSaved={onSaved} />
        </FloatingPrompt>
      )}
    </>
  );
}

/** One-line, save-on-blur note for a single call — writes lead_meetings.notes via the meetings PATCH.
 *  Emphasised (and given a prompt) when the call was disqualified for "Other", the one reason that
 *  otherwise records nothing about WHY. */
function MeetingNote({ value, disabled, emphasize, onSave }: { value: string | null; disabled: boolean; emphasize: boolean; onSave: (notes: string) => void }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);
  const dirty = text.trim() !== (value ?? "").trim();
  return (
    <input
      value={text}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (dirty) onSave(text.trim()); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      maxLength={2000}
      placeholder={emphasize ? "What was the reason? (saved to this call)" : "Add a note about this call…"}
      className={cn(
        "mt-2 h-7 w-full rounded-md border bg-surface-200 px-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-50",
        emphasize ? "border-rose-500/40 focus:border-rose-500/60" : "border-neutral-700 focus:border-neutral-500"
      )}
    />
  );
}

function NotesSection({
  leadId,
  onCountChange,
  onSync,
  initialNotes = null,
  className = "mt-5 border-t border-neutral-800/70 pt-4",
}: {
  leadId: string;
  onCountChange?: (n: number) => void;
  /** Fired with the live list whenever it changes — lets the row keep its notes cache warm so the NEXT
   *  open renders instantly without waiting on GoHighLevel. */
  onSync?: (notes: Note[]) => void;
  /** Cached notes (leads.notes_cache) to render IMMEDIATELY while the live GHL fetch reconciles behind
   *  them — the "open fast, sync after" behavior. Null = no cache → classic loading state. */
  initialNotes?: Note[] | null;
  className?: string;
}) {
  const [notes, setNotes] = useState<Note[] | null>(initialNotes); // null = still loading (no cache to show)
  const [synced, setSynced] = useState(false); // has the live GHL read confirmed what's on screen?
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busyEdit, setBusyEdit] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false); // a transient load blip must NOT zero the row's note chip
  // Report the live count up so the row's note chip can appear/update/vanish without a page reload.
  const onCountRef = useRef(onCountChange);
  onCountRef.current = onCountChange;
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  // Mirrors `notes` into a ref so an undo firing after this component unmounts can still compute the
  // restored count (see remove()'s onAction).
  const notesRef = useRef<Note[] | null>(notes);
  notesRef.current = notes;
  const seededRef = useRef(initialNotes !== null);
  useEffect(() => {
    if (notes !== null) {
      onCountRef.current?.(notes.length);
      onSyncRef.current?.(notes);
    }
  }, [notes]);

  useEffect(() => {
    let alive = true;
    // Seeded from the cache → keep it on screen and revalidate silently; unseeded → classic loading.
    if (!seededRef.current) setNotes(null);
    setLoadFailed(false);
    fetch(`/api/leads/${leadId}/notes`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) { setNotes(Array.isArray(d.notes) ? d.notes : []); setSynced(true); } })
      // On a transient failure keep what's shown (cache or null, NOT []): setting [] fires the count
      // effect and zeroes the row's note chip, making a lead WITH history look note-free. loadFailed
      // shows the error; a cached list stays visible — stale beats blank.
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, [leadId]);

  const add = async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const d = await res.json();
      if (!res.ok || !d.note) throw new Error(d.error ?? "failed");
      setNotes((cur) => [d.note as Note, ...(cur ?? [])]);
      setText("");
    } catch {
      setErr("Couldn't save the note.");
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const body = editing.text.trim();
    if (!body || busyEdit) return;
    setBusyEdit(true);
    setErr(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes?noteId=${encodeURIComponent(editing.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const d = await res.json();
      if (!res.ok || !d.note) throw new Error(d.error ?? "failed");
      setNotes((cur) => (cur ?? []).map((n) => (n.id === editing.id ? { ...n, body: d.note.body } : n)));
      setEditing(null);
    } catch {
      setErr("Couldn't update the note.");
    } finally {
      setBusyEdit(false);
    }
  };

  const remove = async (id: string) => {
    const prev = notes;
    // Capture the BODY before the optimistic filter drops it — it's the only copy once GHL has deleted
    // the note, and it's what the undo re-posts. The × is a hover-revealed one-click delete of a real
    // CRM record, so undo is the whole safety net here.
    const gone = (notes ?? []).find((n) => n.id === id);
    setNotes((cur) => (cur ?? []).filter((n) => n.id !== id)); // optimistic
    if (editing?.id === id) setEditing(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes?noteId=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      if (gone?.body) {
        toast("Note deleted", "success", {
          actionLabel: "Undo",
          duration: 8000,
          // Re-posting mints a NEW GHL note (new id + timestamp) — the body is what a call log is for,
          // so that's an acceptable restore. Failure surfaces rather than silently retrying: note
          // create is deliberately single-attempt (a retried 504 would double-create).
          onAction: async () => {
            try {
              const res2 = await fetch(`/api/leads/${leadId}/notes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body: gone.body }),
              });
              const d2 = await res2.json();
              if (!res2.ok || !d2.note) throw new Error();
              setNotes((cur) => [d2.note as Note, ...(cur ?? [])]);
              // Report the count from HERE rather than relying on the [notes] effect: clicking Undo in
              // the toast is itself an outside-click that closes the notes popup, so this component is
              // usually already unmounted and the effect never fires — leaving the row's note chip
              // hidden for a lead that does have notes.
              onCountRef.current?.(typeof d2.count === "number" ? d2.count : (notesRef.current?.length ?? 0) + 1);
            } catch {
              toast("Couldn't restore the note", "error");
            }
          },
        });
      }
    } catch {
      setNotes(prev ?? []); // restore on failure
      setErr("Couldn't delete the note.");
    }
  };

  return (
    <div className={className}>
      <p className="mono-label">Notes</p>
      <div className="mt-2 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void add(); } }}
          placeholder="Add a note — what happened on the call, next steps…"
          rows={2}
          className="w-full resize-y rounded-md border border-neutral-700 bg-surface-200 px-2.5 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
        <div className="flex items-center gap-3">
          <button type="button" disabled={!text.trim() || saving} onClick={() => void add()} className={PROMPT_BTN}>
            {saving ? "Saving…" : "Save note"}
          </button>
          <span className="text-[11px] text-neutral-600">⌘↵ to save</span>
          {err && <span className="text-[11px] text-rose-400">{err}</span>}
        </div>
      </div>
      {/* Cache freshness line: the list renders instantly from the row's cache; this shows whether the
          live GoHighLevel read has confirmed it yet. Quiet once synced. */}
      {notes !== null && !synced && (
        <p className="mt-2 text-[11px] text-neutral-600">{loadFailed ? "Showing saved copy — couldn't refresh from GoHighLevel." : "Syncing with GoHighLevel…"}</p>
      )}
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
        {notes === null ? (
          loadFailed ? (
            <p className="text-xs text-rose-400">Couldn&apos;t load notes — reopen to retry.</p>
          ) : (
            <p className="text-xs text-neutral-500">Loading…</p>
          )
        ) : notes.length === 0 ? (
          <p className="text-xs text-neutral-600">No notes yet.</p>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="group rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2">
              {editing?.id === n.id ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={editing.text}
                    autoFocus
                    onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void saveEdit(); }
                      else if (e.key === "Escape") setEditing(null);
                    }}
                    rows={2}
                    className="w-full resize-y rounded-md border border-neutral-700 bg-surface-200 px-2.5 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                  <div className="flex items-center gap-3">
                    <button type="button" disabled={!editing.text.trim() || busyEdit} onClick={() => void saveEdit()} className={PROMPT_BTN}>
                      {busyEdit ? "Saving…" : "Save"}
                    </button>
                    <button type="button" className="text-xs text-neutral-400 transition-colors hover:text-neutral-200" onClick={() => setEditing(null)} disabled={busyEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-neutral-200">{n.body}</p>
                    <div className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => setEditing({ id: n.id, text: n.body })}
                        aria-label="Edit note"
                        title="Edit note"
                        className="text-[11px] text-neutral-500 transition-colors hover:text-neutral-200"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(n.id)}
                        aria-label="Delete note"
                        title="Delete note"
                        className="text-sm leading-none text-neutral-600 transition-colors hover:text-rose-400"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  {n.createdAt && <p className="mt-1 text-[11px] tabular-nums text-neutral-500">{fmtNoteDate(n.createdAt)}</p>}
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface AdStat {
  key: string;
  adId: string | null;
  adName: string;
  thumb: string | null;
  image: string | null; // full-res creative for the lightbox
  adSetName: string | null; // the ad set / angle — secondary identity for ambiguous ad names
  adCreatedAt: string | null; // ad launch date
  status: string | null; // the ad's OWN configured switch (fallback while effective is syncing)
  effectiveStatus: string | null; // Meta effective_status — real delivery, the dot's source of truth
  total: number;
  qualified: number;
  unqualified: number;
  pending: number;
  lastLeadAt: number; // ms of the most recent lead for this ad (0 if unknown) — drives the "Most recent" sort
  spend: number | null; // all-time ad spend from fb_insights_daily (null when the row isn't id-keyed / no data)
  cpl: number | null; // spend / leads
  cpq: number | null; // spend / qualified — THE kill/scale number
}

/**
 * What the scoreboard's delivery dot should show for one ad. FOUR outcomes, not two:
 *   live    (green)  — genuinely delivering. A bad ad here is still spending → kill it.
 *   issue   (amber)  — Meta shut it off or is blocking it (disapproved / billing / in review). NOT the
 *                      same as "you paused it": this is actionable.
 *   off     (grey)   — deliberately paused (the ad, its ad set, or its campaign). Ignore.
 *   unknown (hollow) — we can't tell yet. Shown ONLY when the real delivery status hasn't synced AND
 *                      the ad's own switch is ON — because then a paused PARENT would make a green a
 *                      lie. A definitely-off ad is grey even without the synced field.
 *
 * `effective` is Meta's effective_status (the truth, honours parents); `configured` is the ad's own
 * on/off switch, used only as a safe fallback while effective is still syncing.
 */
type DeliveryTone = "live" | "issue" | "off" | "unknown";
function deliveryState(effective: string | null, configured: string | null): { tone: DeliveryTone; label: string } {
  const E = (effective ?? "").toUpperCase();
  if (E) {
    if (E === "ACTIVE" || E === "PREAPPROVED") return { tone: "live", label: "Active — delivering" };
    if (E === "DISAPPROVED") return { tone: "issue", label: "Disapproved by Meta" };
    if (E === "WITH_ISSUES") return { tone: "issue", label: "Has issues" };
    if (E === "PENDING_BILLING_INFO") return { tone: "issue", label: "Halted — billing" };
    if (E === "IN_PROCESS" || E === "PENDING_REVIEW") return { tone: "issue", label: "In review" };
    if (E === "ADSET_PAUSED") return { tone: "off", label: "Ad set paused" };
    if (E === "CAMPAIGN_PAUSED") return { tone: "off", label: "Campaign paused" };
    if (E === "PAUSED") return { tone: "off", label: "Paused" };
    if (E === "ARCHIVED") return { tone: "off", label: "Archived" };
    if (E === "DELETED") return { tone: "off", label: "Deleted" };
    return { tone: "off", label: effective! };
  }
  // effective_status not synced yet. The ad's OWN switch still tells us one thing for certain: a paused
  // ad cannot deliver regardless of its parents, so grey is safe. An ACTIVE ad, though, could sit under
  // a paused ad set — so we must NOT show green; we show "unknown" until the sync confirms.
  const C = (configured ?? "").toUpperCase();
  if (C === "PAUSED" || C === "ARCHIVED" || C === "DELETED") return { tone: "off", label: "Paused" };
  return { tone: "unknown", label: "Delivery status syncing…" };
}

/** EUR display for the scoreboard — account currency is EUR-native (no FX in this app). */
function fmtEur(v: number | null, digits: number): string {
  if (v == null) return "—";
  return `€${v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

type SegTone = "good" | "danger" | "info" | "warn";
// Active button = tonal fill (matches TONE_STYLE badges); inactive = quiet, hue only on hover.
const SEG_ACTIVE: Record<SegTone, string> = {
  good: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  danger: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  info: "border-sky-500/40 bg-sky-500/15 text-sky-300",
  warn: "border-amber-500/40 bg-amber-500/15 text-amber-300",
};
const SEG_HOVER: Record<SegTone, string> = {
  good: "hover:border-emerald-500/30 hover:text-emerald-300",
  danger: "hover:border-rose-500/30 hover:text-rose-300",
  info: "hover:border-sky-500/30 hover:text-sky-300",
  warn: "hover:border-amber-500/30 hover:text-amber-300",
};

/**
 * Compact segmented control for a single lead state (qualification or call state). Clicking an inactive
 * option selects it; clicking the ACTIVE option again clears back to the neutral value. Disabled (with a
 * hover hint) when the lead has no GHL contact to tag yet.
 */
function StateToggle<T extends string>({
  value,
  neutral,
  options,
  onChange,
  busy,
  disabled,
  disabledHint,
}: {
  value: T;
  neutral: T;
  options: { key: T; label: string; tone: SegTone; title?: string }[];
  onChange: (next: T) => void;
  busy: boolean;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <div className="inline-flex items-center gap-1" title={disabled ? disabledHint : undefined}>
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            title={o.title}
            disabled={disabled || busy}
            onClick={(e) => {
              e.stopPropagation();
              onChange(active ? neutral : o.key);
            }}
            className={cn(
              "inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40",
              active ? SEG_ACTIVE[o.tone] : cn("border-neutral-800 bg-transparent text-neutral-500", !disabled && SEG_HOVER[o.tone])
            )}
          >
            {o.label}
          </button>
        );
      })}
      {busy && <span className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-neutral-300" />}
    </div>
  );
}

/** Call-state dropdown. The trigger is tinted by the current state so the column still reads at a
 *  glance (white=called, amber=no answer, rose=invalid, violet=follow up, sky=meeting booked,
 *  neutral=not called). The 2026-07-21 colour pass briefly moved "No answer" to a neutral pill to
 *  reserve amber for the uncalled rail — Miguel preferred the amber fill, so it STAYS amber. Don't
 *  re-neutralise it. (The audit-STARTED dot did stay off amber.) */
const CALL_SELECT_STYLE: Record<CallState, string> = {
  none: "border-neutral-700 bg-surface-200 text-neutral-400",
  contacted: "border-white/30 bg-white/10 text-neutral-50",
  no_answer: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  invalid_phone: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  follow_up: "border-violet-500/40 bg-violet-500/15 text-violet-300",
  // Sky blue — matches the booked-meeting date chip (ApptChip). Blue vs the green Qualified pill reads apart at a glance.
  meeting_booked: "border-sky-500/40 bg-sky-500/15 text-sky-300",
};
const CALL_OPTIONS: { value: CallState; label: string }[] = [
  { value: "none", label: "Not called" },
  { value: "contacted", label: "Called" },
  { value: "no_answer", label: "No answer" },
  { value: "invalid_phone", label: "Invalid number" },
  { value: "follow_up", label: "Follow up" },
  { value: "meeting_booked", label: "Meeting booked" },
];

const CALL_DOT: Record<CallState, string> = {
  none: "bg-neutral-600",
  contacted: "bg-neutral-100",
  no_answer: "bg-amber-400",
  invalid_phone: "bg-rose-400",
  follow_up: "bg-violet-400",
  meeting_booked: "bg-sky-400",
};

const QUAL_OPTIONS: { value: Qualification; label: string }[] = [
  { value: "qualified", label: "Qualified" },
  { value: "unqualified", label: "Unqualified" },
  { value: "pending", label: "Pending" },
];

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

function MinusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Action menu (not a persistent value) for a bulk verb — reuses AppSelect so it matches the app and
 *  never renders a native OS dropdown. Picking fires the action; the trigger always shows the label. */
function BulkSelect({ label, options, onPick, disabled }: { label: string; options: { value: string; label: string }[]; onPick: (v: string) => void; disabled?: boolean }) {
  return <AppSelect value="" placeholder={label} options={options} onChange={onPick} disabled={disabled} className="h-8 min-w-[140px]" />;
}

function CallSelect({
  value,
  onChange,
  busy,
  disabled,
  disabledHint,
}: {
  value: CallState;
  onChange: (next: CallState) => void;
  busy: boolean;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [open, setOpen] = useState(false);
  // Fixed-position menu: the table wrapper is overflow-x-auto and would clip an absolutely-positioned
  // panel, so the menu anchors to the trigger's viewport rect instead (and closes on scroll/resize).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const menuH = CALL_OPTIONS.length * 30 + 10;
    const top = r.bottom + 4 + menuH > window.innerHeight ? r.top - menuH - 4 : r.bottom + 4;
    setPos({ top, left: r.left });
    setOpen(true);
  }

  const current = CALL_OPTIONS.find((o) => o.value === value) ?? CALL_OPTIONS[0];
  return (
    <div className="inline-flex items-center gap-1.5" title={disabled ? disabledHint : undefined}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled || busy}
        onClick={toggle}
        className={cn(
          // 148px: "Meeting booked" (the longest state) fully visible — 128px truncated it (Miguel).
          "inline-flex h-7 w-[148px] items-center justify-between rounded-md border pl-2 pr-1.5 text-xs font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40",
          CALL_SELECT_STYLE[value]
        )}
      >
        {/* Status dot carries the hue now that most triggers are untinted — amber is reserved for
            "needs action now" (the rail), so "No answer" reads by dot + label, not a filled amber box. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CALL_DOT[value])} />
          <span className="truncate">{current.label}</span>
        </span>
        <svg
          className={cn("h-3 w-3 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <div
          className="fixed z-50 w-[150px] rounded-md border border-[#333333] bg-surface-200 p-1 shadow-xl shadow-black/40"
          style={{ top: pos.top, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {CALL_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-neutral-800",
                o.value === value ? "bg-neutral-800/60 text-neutral-100" : "text-neutral-300"
              )}
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CALL_DOT[o.value])} />
              {o.label}
            </button>
          ))}
        </div>
      )}
      {busy && <span className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-neutral-300" />}
    </div>
  );
}

function StageChip({ stage }: { stage: "started" | "completed" }) {
  return stage === "completed" ? (
    <Chip className={cn(TONE_STYLE.good, "text-[10px] font-medium uppercase tracking-wide")}>Completed</Chip>
  ) : (
    <Chip className={cn(TONE_STYLE.warn, "text-[10px] font-medium uppercase tracking-wide")}>Started</Chip>
  );
}

/**
 * Compact ROI-audit stage marker for the Lead cell — a leading icon, NOT a text pill: the old
 * "STARTED"/"COMPLETED" pill sat inline and ate the whole name column on audit leads. Completed = a
 * green check-circle, Started = an amber in-progress circle; the full word lives in the expanded panel.
 */
function StageDot({ stage }: { stage: "started" | "completed" }) {
  const done = stage === "completed";
  // "Started" stays AMBER (Miguel, 2026-07-21): an abandoned ROI audit is a live opening, not a
  // footnote — grey buried it. Do NOT re-neutralise this to reserve amber for "needs action now".
  return (
    <span title={`ROI audit — ${done ? "completed" : "started"}`} className={cn("inline-flex shrink-0", done ? "text-emerald-400" : "text-amber-400")}>
      {done ? (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )}
    </span>
  );
}

/** qualified ÷ (qualified + unqualified); null when no decisions have been made yet. */
/** Decided leads = the ones a quality rate is actually built on. */
function decided(s: { qualified: number; unqualified: number }): number {
  return s.qualified + s.unqualified;
}
/** An ad's qualified rate, or null when nothing is decided yet. The rate exists at 1 decided lead — it
 *  just isn't TRUSTWORTHY yet; trust is the ranking's job (MIN_DECIDED), not this function's. */
function rate(s: { qualified: number; unqualified: number }): number | null {
  const denom = decided(s);
  return denom === 0 ? null : s.qualified / denom;
}
/** Below this many decided leads, a quality score is a fluke: it still shows, but it's greyed and sinks
 *  to the bottom of Best/Worst instead of topping the ranking (Miguel's call, 2026-07-21). */
const MIN_DECIDED = 3;
function trusted(s: { qualified: number; unqualified: number }): boolean {
  return decided(s) >= MIN_DECIDED;
}

/** A lead "came from an ad" if it carries an ad id, or its tracking tagged it as Paid Ads. Direct leads
 *  (people who just hit the URL, no ad tag) are NOT ad leads and must not pollute the per-ad breakdown. */
function isAdLead(l: LeadView): boolean {
  // source==="instant_form" included so this predicate is IDENTICAL to queries.ts sourceBucket's ads
  // test — a hypothetical form lead missing adId+channel must not read Ads on Overview but Organic here.
  return l.source === "instant_form" || !!l.adId || l.channel === "Paid Ads";
}
/** Scoreboard grouping key: ad id → ad name (id lost in tracking) → paid-but-unknown → non-ad source. */
/** Non-ad lead sources the Source column + filter know beyond ads. Keys are the filter bucket ids. */
const OUTBOUND_SOURCES = [
  { key: "__cold__", source: "cold_call", label: "Cold call" },
  { key: "__cold_email__", source: "cold_email", label: "Cold email" },
  { key: "__organic__", source: "organic", label: "Organic" },
  { key: "__li__", source: "linkedin_dm", label: "LinkedIn DMs" },
  { key: "__ref__", source: "referral", label: "Referrals" },
] as const;
/**
 * The row's non-ad source entry, or null for ad leads. "Direct" is GONE as a bucket (Miguel, 2026-07-23
 * — "isn't direct basically organic?"): an unattributed website lead IS organic (found us on their own),
 * unless its tracked channel says Referral. Tag-sourced rows (cold_call/…/referral) match by source.
 */
function outboundFor(l: LeadView) {
  const tagged = OUTBOUND_SOURCES.find((o) => o.source === l.source);
  if (tagged) return tagged;
  if (isAdLead(l)) return null;
  return OUTBOUND_SOURCES.find((o) => o.key === (l.channel === "Referral" ? "__ref__" : "__organic__"))!;
}
/** Same 14px stroke-icon language as the rest of the app; LinkedIn is the one filled silhouette (like
 *  the WhatsApp glyph) because its mark doesn't read as strokes at this size. */
function OutboundIcon({ source, className }: { source: string; className?: string }) {
  if (source === "cold_email") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 6-10 7L2 6" />
      </svg>
    );
  }
  if (source === "organic") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    );
  }
  if (source === "linkedin_dm") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z" />
      </svg>
    );
  }
  if (source === "referral") {
    // Person + plus: someone brought them in.
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.1 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function leadKey(l: LeadView): string {
  const ob = outboundFor(l);
  if (ob) return ob.key; // every non-ad lead lands in a named source bucket (direct merged into organic)
  return l.adId ? `id:${l.adId}` : l.adName ? `name:${l.adName}` : "__paid_unknown__";
}

export function LeadsView({
  leads: rawLeads,
  ghlConfigured,
  canDelete = false,
  spendByAd = {},
  initialQ,
  waTemplates = {},
  syncedAt = null,
}: {
  leads: LeadView[];
  ghlConfigured: boolean;
  canDelete?: boolean;
  /** WhatsApp template bodies from Settings, keyed by setting key. Missing keys fall back to defaults. */
  waTemplates?: Record<string, unknown>;
  /** Newest leads.synced_at — how fresh THIS tab's data is (the sidebar's clock is the ad-spend sync). */
  syncedAt?: string | null;
  /** All-time spend per fb_ad_id (fb_insights_daily rollup) — powers Spend/CPL/Cost-per-qualified. */
  spendByAd?: Record<string, number>;
  /** view + discrete filters now come from the URL via useSearchParams; only the transient search box
   *  is seeded from a prop. */
  initialQ?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);

  /**
   * Locally-known changes overlaid on the server rows.
   *
   * Every row action used to end in router.refresh(), which re-runs the whole server page: the paged
   * leads read, ads, ad sets, meetings, settings and the spend rollup, then re-renders every row. One
   * qualify click cost ~10 sequential database round trips and a full re-render, on top of the
   * GoHighLevel write already in flight.
   *
   * The refresh existed because the header counts, queue buckets and filters all read the `leads`
   * array, not row state, so skipping it naively made the tabs disagree with the rows (that exact bug
   * has bitten this file before). Merging the change into the array instead keeps every one of those
   * derived numbers correct with no server round trip at all.
   *
   * Server data always wins: the moment a real refresh delivers new rows, the overlay is dropped.
   */
  const [patches, setPatches] = useState<Map<string, { at: number; patch: Partial<LeadView> }>>(new Map());
  const leads = useMemo(
    () => (patches.size ? rawLeads.map((l) => (patches.has(l.id) ? { ...l, ...patches.get(l.id)!.patch } : l)) : rawLeads),
    [rawLeads, patches]
  );
  useEffect(() => {
    // Server data wins, EXCEPT for writes made in the last few seconds. A refresh triggered by some
    // other action (a delete, a bulk apply, a meeting outcome) can be read by the server BEFORE a
    // just-committed write and arrive after it, which would wipe the overlay back to the stale value
    // and make the operator watch their own click undo itself. Anything this recent is already
    // persisted, so keeping it is safe; the next refresh clears it.
    const cutoff = Date.now() - 6000;
    setPatches((p) => {
      if (!p.size) return p;
      const next = new Map([...p].filter(([, v]) => v.at > cutoff));
      return next.size === p.size ? p : next;
    });
  }, [rawLeads]);

  /**
   * Row callbacks, stable across renders and keyed by lead id.
   *
   * They take the id as an argument rather than closing over it so their identity never changes, which
   * is what lets FragmentRow be memoized: with fresh inline closures every render, React.memo would
   * compare unequal every time and re-render all N rows on any parent state change.
   */
  const handleToggle = useCallback((id: string) => setExpanded((cur) => (cur === id ? null : id)), []);
  const handleSelect = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  /**
   * A row finished a write.
   *  - note  → it failed. The row has already rolled its own state back, so there is nothing to reload;
   *            surface the message at the click (audit 49) and stop.
   *  - patch → we know exactly what changed. Merge it and skip the server round trip entirely.
   *  - neither → the change touched something only the server can derive (meeting attendance feeds
   *            needsRebook / latestAttendance), so fall back to a real refresh.
   */
  const handleSaved = useCallback(
    (id: string, note: string | null, patch?: Partial<LeadView>) => {
      if (note) {
        toast(note, "error");
        return;
      }
      if (patch) {
        setPatches((prev) => {
          const next = new Map(prev);
          next.set(id, { at: Date.now(), patch: { ...next.get(id)?.patch, ...patch } });
          return next;
        });
        return;
      }
      router.refresh();
    },
    [router]
  );
  // Three views on one tab: CRM / Ad-quality scoreboard / Tasks queue. View + filters are LOCAL state so
  // switching is INSTANT (no server round-trip — that was the lag). They're mirrored to the URL via
  // history.replaceState (the effect below) so a refresh or shared link still restores the working set,
  // and because replaceState keeps the URL honest, a filter can never hide under a clean URL. Initialized
  // once from the URL on mount.
  const [view, setView] = useState<"leads" | "ads" | "tasks">(() => {
    const v = searchParams.get("view");
    return v === "ads" ? "ads" : v === "tasks" ? "tasks" : "leads";
  });
  const switchView = setView;
  const [status, setStatus] = useState<"all" | Qualification>(() => {
    const s = searchParams.get("status");
    return s === "qualified" || s === "unqualified" || s === "pending" ? s : "all";
  });
  // Raw ad-filter value from the URL; validated against real options (below) so a stale ?ad= can't empty
  // the table. The Leads tab opens with the To-call filter OFF (Miguel 2026-07-20) — only ?tocall=1 turns it on.
  const [adFilterRaw, setAdFilter] = useState<string>(() => searchParams.get("ad") ?? "all");
  const [callFilterRaw, setCallFilter] = useState<string>(() => searchParams.get("call") ?? "all");
  const [uncontactedOnly, setUncontactedOnly] = useState<boolean>(() => searchParams.get("tocall") === "1");
  const [q, setQ] = useState(initialQ ?? "");
  // The input is bound to `q` (instant feedback); `qFilter` is what the filter memo reads. Without this
  // every keystroke re-filtered, re-sorted and re-rendered every row in the table.
  const [qFilter, setQFilter] = useState(initialQ ?? "");
  /**
   * How many rows are actually in the DOM. Every matching lead used to render at once; each row is
   * ~66 elements and ~37 hooks, so a few hundred leads meant tens of thousands of both. A prefix slice
   * keeps the queue's section grouping intact (the headers only compare against the previous row, and
   * a prefix preserves contiguity), unlike numbered pages which would fragment the groups.
   */
  const PAGE = 100;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    const t = window.setTimeout(() => setQFilter(q), 180);
    return () => window.clearTimeout(t);
  }, [q]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scoreSort, setScoreSort] = useState<"recent" | "leads" | "worst" | "best" | "cpq">("recent");
  const [activeAdsOnly, setActiveAdsOnly] = useState(false);
  /** Click an ad on the scoreboard → jump to the Leads list showing only that ad. Uses the filter the
   *  Leads view already keys off, so the ad dropdown and the table land in sync. */
  const openAdLeads = useCallback((adKey: string) => {
    setAdFilter(adKey);
    setStatus("all");
    setCallFilter("all");
    setUncontactedOnly(false);
    setQ("");
    switchView("leads");
  }, [switchView]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const totals = useMemo(() => {
    const t = { total: leads.length, qualified: 0, unqualified: 0, pending: 0, matched: 0 };
    for (const l of leads) {
      t[l.qualification]++;
      if (l.matched) t.matched++;
    }
    return t;
  }, [leads]);

  // "Quality by ad" counts ONLY leads that came from an ad. Every non-ad lead lands in a named source
  // bucket (cold call / cold email / organic / LinkedIn / referral — "direct" merged into organic,
  // Miguel 2026-07-23), so nothing inflates an ad's lead count.
  const { adStats, outbound } = useMemo(() => {
    const m = new Map<string, AdStat>();
    const outbound = new Map<string, number>();
    for (const l of leads) {
      const ob = outboundFor(l);
      if (ob) {
        outbound.set(ob.key, (outbound.get(ob.key) ?? 0) + 1);
        continue;
      }
      const key = leadKey(l);
      let s = m.get(key);
      if (!s) {
        s = { key, adId: l.adId, adName: l.adName ?? l.adId ?? "Paid Ads · ad unknown", thumb: l.adThumbUrl, image: l.adImageUrl, adSetName: l.adSetName ?? null, adCreatedAt: l.adCreatedAt ?? null, status: l.adStatus ?? null, effectiveStatus: l.adEffectiveStatus ?? null, total: 0, qualified: 0, unqualified: 0, pending: 0, lastLeadAt: 0, spend: null, cpl: null, cpq: null };
        m.set(key, s);
      }
      if (!s.adSetName && l.adSetName) s.adSetName = l.adSetName;
      s.total++;
      s[l.qualification]++;
      const t = l.createdTime ? new Date(l.createdTime).getTime() : 0;
      if (t > s.lastLeadAt) s.lastLeadAt = t;
      if (!s.thumb && l.adThumbUrl) s.thumb = l.adThumbUrl;
      if (!s.image && l.adImageUrl) s.image = l.adImageUrl;
    }
    const arr = [...m.values()];
    for (const s of arr) {
      const spend = s.adId != null ? spendByAd[s.adId] : undefined;
      s.spend = typeof spend === "number" ? spend : null;
      // Zero-spend ads get no CPL/CPQ — €0.00 would top "Cheapest qualified" and read as a free Meet.
      s.cpl = s.spend != null && s.spend > 0 && s.total > 0 ? s.spend / s.total : null;
      s.cpq = s.spend != null && s.spend > 0 && s.qualified > 0 ? s.spend / s.qualified : null;
    }
    arr.sort((a, b) => {
      if (scoreSort === "recent") return b.lastLeadAt - a.lastLeadAt; // ad with the newest lead first
      if (scoreSort === "leads") return b.total - a.total;
      if (scoreSort === "cpq") {
        // Trust gate first, exactly like Best/Worst: an untrusted ad (too few decided leads) can't top
        // "Cheapest qualified" on a lucky single €20 conversion. Then cheapest first; ads with no
        // qualified lead (or no spend data) sink.
        const ta = trusted(a), tb = trusted(b);
        if (ta !== tb) return ta ? -1 : 1;
        if (a.cpq == null && b.cpq == null) return b.qualified - a.qualified;
        if (a.cpq == null) return 1;
        if (b.cpq == null) return -1;
        return a.cpq - b.cpq;
      }
      // Trust gate FIRST: a 100%-on-1-lead ad is a fluke, not the best ad. Anything below MIN_DECIDED
      // decided leads sinks beneath every trusted ad, in BOTH Best and Worst — a single unqualified
      // lead shouldn't crown the worst ad in the account any more than a single qualified one crowns
      // the best. Within the trusted tier it's the rate; ties break toward the bigger sample.
      const ta = trusted(a), tb = trusted(b);
      if (ta !== tb) return ta ? -1 : 1;
      const ra = rate(a);
      const rb = rate(b);
      if (ra === null && rb === null) return b.total - a.total;
      if (ra === null) return 1; // undecided ads sink to the bottom
      if (rb === null) return -1;
      if (ra !== rb) return scoreSort === "worst" ? ra - rb : rb - ra; // worst = lowest first; best = highest
      return decided(b) - decided(a); // equal rate → more decided leads ranks higher
    });
    return { adStats: arr, outbound };
  }, [leads, scoreSort, spendByAd]);

  // "Active only" hides ads Meta has already paused, so the board shows just what's still spending.
  // A null status (website/unknown ad) is NOT hidden — hiding an ad we can't classify would lose leads.
  const shownAdStats = useMemo(
    // Keep genuinely-delivering ads AND unknown-status ones (hiding an ad we can't classify would lose
    // its leads); drop everything Meta reports as off.
    // Hide only the deliberately-off ads; keep live, issue (Meta-flagged, still actionable) and
    // unknown (not synced) — hiding an ad we can't classify would lose its leads.
    () => (activeAdsOnly ? adStats.filter((s) => deliveryState(s.effectiveStatus, s.status).tone !== "off") : adStats),
    [adStats, activeAdsOnly]
  );
  const pausedAdCount = useMemo(() => adStats.filter((s) => deliveryState(s.effectiveStatus, s.status).tone === "off").length, [adStats]);

  const adOptions = useMemo(() => {
    const opts = adStats.map((s) => ({ id: s.key, name: s.adName }));
    // Always listed, even at 0 — the non-ad sources are selectable from day one (Miguel, 2026-07-22).
    for (const o of OUTBOUND_SOURCES) opts.push({ id: o.key, name: `${o.label} (${outbound.get(o.key) ?? 0})` });
    return opts;
  }, [adStats, outbound]);

  // A stale ?ad= (renamed ad, or its leads all deleted) points at a key no longer in the options — that
  // would silently empty the table. Fall back to "all" when the value isn't a real option.
  const adFilter = adFilterRaw !== "all" && adOptions.some((o) => o.id === adFilterRaw) ? adFilterRaw : "all";
  // Call-status filter (mirrors the ad filter). Falls back to "all" if the URL carries an unknown state.
  const callFilter = callFilterRaw !== "all" && CALL_OPTIONS.some((o) => o.value === callFilterRaw) ? callFilterRaw : "all";

  // Mirror view + filters to the URL WITHOUT a server round-trip (history.replaceState) — refresh/shared
  // links restore the working set, switching stays instant. Only non-default params are written.
  useEffect(() => {
    const p = new URLSearchParams();
    if (view !== "leads") p.set("view", view);
    if (status !== "all") p.set("status", status);
    if (adFilter !== "all") p.set("ad", adFilter);
    if (callFilter !== "all") p.set("call", callFilter);
    if (uncontactedOnly) p.set("tocall", "1");
    if (q.trim()) p.set("q", q.trim());
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `/leads?${qs}` : "/leads");
  }, [view, status, adFilter, callFilter, uncontactedOnly, q]);

  // Any change to what is being shown starts the list from the top again — and drops any selection made
  // under the old working set, so a bulk action can never mutate leads the operator can no longer see
  // (rows picked under a filter that no longer applies).
  useEffect(() => { setLimit(PAGE); setSelected(new Set()); }, [view, status, adFilter, callFilter, uncontactedOnly, qFilter]);

  // Minute tick: the day-before confirmation window is TIME-based (opens at noon), so the queue memos
  // below re-evaluate once a minute — otherwise a tab left open all morning would never surface the
  // "Confirm tomorrow's call" section at 12:00 until some unrelated interaction re-rendered it.
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const needle = qFilter.trim().toLowerCase();
    const needleDigits = needle.replace(/\D/g, "");
    const arr = leads.filter((l) => {
      if (status !== "all" && l.qualification !== status) return false;
      if (adFilter !== "all" && leadKey(l) !== adFilter) return false;
      if (callFilter !== "all" && l.callState !== callFilter) return false;
      // "To call" = NOT YET CALLED, full stop. Miguel's rule (2026-07-20): the ONLY thing that takes a
      // lead off the call queue / amber rail is moving the Call dropdown off "Not called". Qualification
      // must NOT — he often qualifies straight from the form answers without ever dialing — and a booked
      // meeting doesn't touch the call dropdown either. Same predicate as the amber rail + count.
      if (view === "leads" && uncontactedOnly && l.callState !== "none") return false;
      // The Tasks tab is the ONE daily worklist: open reminders AND leads nobody has dialled yet.
      // Before, a never-called lead appeared in no queue at all unless the tab happened to be empty —
      // fresh paid leads went cold in a tab the operator wasn't looking at.
      if (view === "tasks" && !l.taskId && l.callState !== "none" && !l.needsRebook && !l.awaitingOutcome && !leadNeedsConfirmation(l)) return false;
      if (needle) {
        const name = (l.fullName ?? "").toLowerCase();
        const phone = (l.phone ?? "").toLowerCase();
        // Match any number tied to the lead: the corrected one, the one Meta originally delivered
        // (still on old Slack cards/exports), and the additional phone.
        const matchesPhone =
          needleDigits.length >= 3 &&
          [l.phone, l.phoneOriginal, l.additionalPhone].some((p) => (p ?? "").replace(/\D/g, "").includes(needleDigits));
        // Email too — the newer forms collect it, and operators search by it (M2).
        const matchesEmail = [l.email, l.emailOriginal, l.additionalEmail].some((e) => (e ?? "").toLowerCase().includes(needle));
        if (!name.includes(needle) && !phone.includes(needle) && !matchesPhone && !matchesEmail) return false;
      }
      return true;
    });
    // The Tasks view is a work queue — soonest due first (undated last). Every other view keeps the
    // default NEWEST-lead-first order (the `leads` prop is already created_time DESC) — Miguel's
    // preference 2026-07-20 (reverts the M1 oldest-first-in-call-queue sort).
    if (view === "tasks") {
      // Work order = the queue's own grouping (overdue → today → needs-first-call → this week → later),
      // then soonest-due inside a bucket. Never-called leads sort oldest-first: the lead that has been
      // waiting longest for its first dial is the one most at risk of going cold.
      arr.sort((a, b) => {
        const qa = queueBucket(a), qb = queueBucket(b);
        if (qa.rank !== qb.rank) return qa.rank - qb.rank;
        if (qa.key === "firstcall") return String(a.createdTime ?? "").localeCompare(String(b.createdTime ?? ""));
        return String(a.taskDueAt ?? "9999").localeCompare(String(b.taskDueAt ?? "9999"));
      });
    }
    return arr;
  }, [leads, status, adFilter, callFilter, uncontactedOnly, view, qFilter, clockTick]); // eslint-disable-line react-hooks/exhaustive-deps -- clockTick re-evaluates the time-windowed confirm predicate

  // Open-task tally for the toolbar chip: overdue beats due-today for the icon's urgency tint.
  const taskCounts = useMemo(() => {
    // Counts EVERYTHING the queue shows AND classifies each lead with the SAME queueBucket the sections
    // render from, so the badge can never disagree with what's on screen — a no-showed lead with a stale
    // open task belongs under "Missed — rebook", not "Overdue", and must not inflate the overdue dot.
    const t = { total: 0, today: 0, overdue: 0, firstCall: 0 };
    for (const l of leads) {
      if (!l.taskId && l.callState !== "none" && !l.needsRebook && !l.awaitingOutcome && !leadNeedsConfirmation(l)) continue;
      t.total++;
      const key = queueBucket(l).key;
      if (key === "overdue") t.overdue++;
      else if (key === "today") t.today++;
      else if (key === "firstcall") t.firstCall++;
    }
    return t;
  }, [leads, clockTick]); // eslint-disable-line react-hooks/exhaustive-deps -- clockTick re-evaluates the time-windowed confirm predicate

  // How many leads still need a first call — drives the "to call" filter chip.
  const uncontactedCount = useMemo(
    () => leads.filter((l) => l.callState === "none").length,
    [leads]
  );

  // When any lead carries an ROI-audit link, every row reserves an "Audit ↗" slot — that makes the
  // action cluster wider, which the fixed Actions column must account for or it overlaps Qualification.
  const hasAudit = useMemo(() => leads.some((x) => !!x.auditUrl), [leads]);
  // Column widths come from the shared layout module (kept in sync with the page container's cap, so
  // the Lead column can't balloon on a wide monitor). Below tableMinW the table scrolls horizontally
  // rather than crushing the name column (user 2026-07-20: names must stay readable).
  const visible = useMemo(() => (filtered.length > limit ? filtered.slice(0, limit) : filtered), [filtered, limit]);
  const actionsW = hasAudit ? LEADS_COLS.actionsAudit : LEADS_COLS.actions;
  const tableMinW = leadsTableMinWidth(hasAudit);

  async function refresh() {
    setBusy(true);
    try {
      const res = await fetch("/api/leads/refresh", { method: "POST" });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        toast(j?.error || "Refresh failed.", "error");
      } else if (j.skipped === "active-launch") {
        // Deliberately NOT an error: the refusal is the system protecting a live launch.
        toast(j.note ?? "A launch is in progress — try again shortly.");
      } else {
        toast(
          `Synced ${j.leadsSeen} lead${j.leadsSeen === 1 ? "" : "s"} · ${j.matched}/${j.leadsSeen} matched to GoHighLevel` +
            (j.matchedByEmail ? ` (${j.matchedByEmail} via email)` : "")
        );
        router.refresh();
      }
    } catch {
      toast("Refresh failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const bulkCancelRef = useRef(false);

  // Precompute each lead's queue bucket + per-bucket counts ONCE per filtered set, so the Tasks-view row
  // map doesn't call queueBucket 2-3x per row plus a full filtered.filter per section header every render.
  const bucketInfo = useMemo(() => {
    const counts = new Map<QueueKey, number>();
    const keyById = new Map<string, QueueKey>();
    if (view === "tasks") {
      for (const l of filtered) {
        const k = queueBucket(l).key;
        keyById.set(l.id, k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return { counts, keyById };
  }, [filtered, view]);
  // Memoized so the header checkbox doesn't run two O(N) filtered.every scans on every render.
  const allFilteredSelected = useMemo(() => filtered.length > 0 && filtered.every((l) => selected.has(l.id)), [filtered, selected]);

  /** Download the CURRENTLY-FILTERED leads as CSV (M3) — what you see is what you export. */
  function exportCsv() {
    const cols: [string, (l: LeadView) => string][] = [
      ["Name", (l) => l.fullName ?? ""],
      ["Phone", (l) => l.phone ?? ""],
      ["Email", (l) => l.email ?? ""],
      ["Website", (l) => l.website ?? ""],
      ["Ad", (l) => l.adName ?? ""],
      ["Ad set", (l) => l.adSetName ?? ""],
      ["Submitted", (l) => l.createdTime ?? ""],
      ["Call state", (l) => l.callState],
      ["Attempts", (l) => String(l.callAttempts)],
      ["Qualification", (l) => l.qualification],
      ["Task", (l) => l.taskTitle ?? ""],
      ["Task due", (l) => l.taskDueAt ?? ""],
    ];
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [cols.map((c) => c[0]).join(","), ...filtered.map((l) => cols.map((c) => esc(c[1](l))).join(","))];
    // ﻿ BOM so Excel reads the Portuguese accents as UTF-8.
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${filtered.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Apply one call-state / qualification value to every selected lead via the same PATCH the row uses.
   *  Sequential (kind to GHL's rate limit); reports how many took and how many were skipped/failed. */
  async function bulkApply(kind: "callState" | "qualification", value: string) {
    const ids = [...selected];
    if (!ids.length) return;
    bulkCancelRef.current = false;
    setBulkBusy(true);
    setBulkProgress({ done: 0, total: ids.length });
    let ok = 0;
    let failed = 0;
    let cancelled = false;
    for (let i = 0; i < ids.length; i++) {
      if (bulkCancelRef.current) { cancelled = true; break; }
      try {
        const res = await fetch(`/api/leads/${ids[i]}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [kind]: value }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.ok) ok++;
        else failed++;
      } catch {
        failed++;
      }
      setBulkProgress({ done: i + 1, total: ids.length });
    }
    setBulkBusy(false);
    setBulkProgress(null);
    if (!cancelled) setSelected(new Set());
    toast(
      `Updated ${ok} lead${ok === 1 ? "" : "s"}${failed ? ` · ${failed} skipped (not linked to GoHighLevel)` : ""}${cancelled ? " · cancelled" : ""}`,
      failed || cancelled ? "error" : "success"
    );
    router.refresh();
  }

  /** Delete one lead. Records a durable exclusion server-side so it stays gone across syncs and drops out
   *  of every leads/CPL number; optionally removes the person from GoHighLevel too. The row itself is
   *  SOFT-deleted, so Undo restores it exactly — corrected phone, notes, call attempts and all. */
  const deleteLead = useCallback(async function deleteLead(lead: LeadView, alsoDeleteGhl: boolean): Promise<boolean> {
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alsoDeleteGhl }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        toast(j?.error || "Delete failed.", "error");
        return false;
      }
      // A ghlWarning means the lead went but GHL didn't — that's a failure to surface, not a success.
      if (j.ghlWarning) toast(j.ghlWarning, "error");
      else if (j.restorable === false) {
        // The GoHighLevel contact was deleted too — its tags, notes, tasks and appointments are gone for
        // good. Offering "Undo" here would promise a restore we can't deliver, so we deliberately don't.
        toast(`Deleted ${lead.fullName || "lead"} (and from GoHighLevel — not reversible)`);
      } else {
        toast(`Deleted ${lead.fullName || "lead"}`, "success", {
          actionLabel: "Undo",
          duration: 12000, // longest window in the app: this one moves team-wide metrics
          onAction: async () => {
            try {
              const r = await fetch(`/api/leads/${lead.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "restore" }),
              });
              const d = await r.json().catch(() => ({}));
              if (!r.ok || !d.ok) throw new Error(d?.error ?? "failed");
              toast(`Restored ${lead.fullName || "lead"}`);
              router.refresh();
            } catch {
              toast("Couldn't restore the lead.", "error");
            }
          },
        });
      }
      router.refresh();
      return true;
    } catch {
      toast("Delete failed.", "error");
      return false;
    }
  }, [router]);

  // The Tasks view's tabs count only the open-task queue — "All (28)" over a 3-row queue would lie.
  const queueTotals = useMemo(() => {
    const t = { total: 0, qualified: 0, unqualified: 0, pending: 0 };
    for (const l of leads) {
      // MUST match the queue's row predicate exactly (see `filtered`): an open reminder OR a lead
      // still awaiting its first call. Counting only reminders made the status tabs read "All (0)"
      // above a dozen visible rows, and a "Pending (0)" tab that filtered to a non-empty list.
      if (!l.taskId && l.callState !== "none" && !l.needsRebook && !l.awaitingOutcome && !leadNeedsConfirmation(l)) continue;
      t.total++;
      t[l.qualification]++;
    }
    return t;
  }, [leads, clockTick]); // eslint-disable-line react-hooks/exhaustive-deps -- clockTick re-evaluates the time-windowed confirm predicate
  const tabTotals = view === "tasks" ? queueTotals : totals;
  // Each count pill reserves the width of the WIDER of the two views' numbers, so toggling Leads<->Tasks
  // (same four words, different counts) can never grow or shrink the boxed frame — only the digits change.
  const digitsFor = (a: number, b: number) => String(Math.max(a, b)).length;
  const STATUS_TABS: Array<{ key: "all" | Qualification; label: string; count: number; digits: number }> = [
    { key: "all", label: "All", count: tabTotals.total, digits: digitsFor(totals.total, queueTotals.total) },
    { key: "qualified", label: "Qualified", count: tabTotals.qualified, digits: digitsFor(totals.qualified, queueTotals.qualified) },
    { key: "unqualified", label: "Unqualified", count: tabTotals.unqualified, digits: digitsFor(totals.unqualified, queueTotals.unqualified) },
    { key: "pending", label: "Pending", count: tabTotals.pending, digits: digitsFor(totals.pending, queueTotals.pending) },
  ];

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Total leads" value={String(totals.total)} />
        <Kpi label="Qualified" value={String(totals.qualified)} tone={totals.qualified ? "good" : undefined} />
        <Kpi label="Unqualified" value={String(totals.unqualified)} tone={totals.unqualified ? "bad" : undefined} />
        <Kpi label="Pending review" value={String(totals.pending)} muted />
      </div>

      {/* Header row: view toggle + GHL match health + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center rounded-md border border-neutral-800 bg-panel p-0.5">
          {(
            [
              { key: "leads", label: "Leads" },
              { key: "ads", label: "Ad quality" },
              { key: "tasks", label: `Tasks (${taskCounts.total})` },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => switchView(t.key)}
              className={cn(
                "inline-flex h-7 items-center rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none",
                view === t.key ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"
              )}
            >
              {t.label}
              {t.key === "tasks" && (taskCounts.overdue > 0 || taskCounts.today > 0) && (
                <span
                  title={taskCounts.overdue > 0 ? `${taskCounts.overdue} overdue` : `${taskCounts.today} due today`}
                  className={cn("ml-1.5 h-1.5 w-1.5 rounded-full", taskCounts.overdue > 0 ? "bg-rose-400" : "bg-amber-400")}
                />
              )}
            </button>
          ))}
        </div>
        <GhlHealth ghlConfigured={ghlConfigured} total={totals.total} matched={totals.matched} />
        </div>
        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-start">
          {/* How fresh THIS tab is. Without it an empty Meeting cell reads the same whether nobody has
              booked or we simply haven't checked since they did. The sidebar's clock can't answer this:
              it tracks the ad-spend sync and stays put after a leads refresh. */}
          <FreshnessChip syncedAt={syncedAt} busy={busy} />
          <button
            onClick={refresh}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-3 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50 sm:h-7 sm:px-2.5"
          >
            {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border border-neutral-600 border-t-neutral-200" />}
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Ad scoreboard */}
      {view === "ads" && adStats.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          No ad-attributed leads yet — quality by ad fills in as your ads collect leads.
        </div>
      )}
      {view === "ads" && adStats.length > 0 && (
        <>
          {/* Same toolbar pattern as the Leads view: the sort options sit in the SAME boxed frame as the
              status filters / view switcher, so all three views read as one system. min-h keeps this row
              level with the Leads/Tasks toolbars. */}
          <div className="flex min-h-[34px] flex-wrap items-center gap-3">
            <div className="no-scrollbar -mx-1 flex w-full gap-0.5 overflow-x-auto px-1 sm:mx-0 sm:w-auto sm:rounded-md sm:border sm:border-neutral-800 sm:bg-panel sm:p-0.5">
              {(
                [
                  { key: "recent", label: "Most recent" },
                  { key: "leads", label: "Most leads" },
                  { key: "worst", label: "Worst quality" },
                  { key: "best", label: "Best quality" },
                  { key: "cpq", label: "Cheapest qualified" },
                ] as const
              ).map((o) => (
                <button
                  key={o.key}
                  onClick={() => setScoreSort(o.key)}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded px-3 text-xs font-medium transition-colors",
                    scoreSort === o.key ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {pausedAdCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveAdsOnly((v) => !v)}
                title="Hide ads Meta has already paused, so only what's still spending shows"
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors",
                  activeAdsOnly
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    : "border-neutral-700 bg-surface-200 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", activeAdsOnly ? "bg-emerald-400" : "bg-emerald-500/60")} />
                Active only
                {!activeAdsOnly && <span className="tabular-nums text-neutral-600">({pausedAdCount} paused)</span>}
              </button>
            )}
          </div>
          {activeAdsOnly && shownAdStats.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              No active ads have leads yet. <button type="button" className="text-accent hover:underline" onClick={() => setActiveAdsOnly(false)}>Show paused too</button>
            </div>
          ) : (
          <section className="ads-scroll overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
          <div>
            <table className="ads-table min-w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 bg-panel">
                  <th className="pl-5 pr-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Ad</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Spend</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Leads</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">CPL</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Qualified</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Unqualified</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Pending</th>
                  <th className="px-4 py-2.5 text-right font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Cost / qualified</th>
                  <th className="pl-4 pr-5 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Qualified rate</th>
                </tr>
              </thead>
              <tbody>
                {shownAdStats.map((s) => {
                  const r = rate(s);
                  const delivery = deliveryState(s.effectiveStatus, s.status);
                  const drill = s.key !== "__paid_unknown__"; // a nameless "ad unknown" bucket has nothing to drill into
                  return (
                    <tr
                      key={s.key}
                      onClick={drill ? () => openAdLeads(s.key) : undefined}
                      className={cn(
                        "border-b border-neutral-800 last:border-0",
                        drill ? "cursor-pointer hover:bg-surface-200/50" : ""
                      )}
                      title={drill ? "Open this ad's leads" : undefined}
                    >
                      <td className="pl-5 pr-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          {/* Delivery dot, four tones: green = genuinely delivering (a bad one here is
                              still spending → kill it); AMBER = Meta shut it off or is blocking it
                              (disapproved / billing / in review) — actionable, not the same as a
                              deliberate pause; grey = deliberately paused (ad, ad set or campaign);
                              hollow = real status not synced yet. Reads effective_status so a paused
                              ANGLE (ad set) never shows a false green. */}
                          <span
                            title={delivery.label}
                            role="img"
                            aria-label={`Delivery: ${delivery.label}`}
                            className={cn(
                              "h-1.5 w-1.5 shrink-0 rounded-full",
                              delivery.tone === "live" && "bg-emerald-400",
                              delivery.tone === "issue" && "bg-amber-400",
                              delivery.tone === "off" && "bg-neutral-600",
                              delivery.tone === "unknown" && "bg-transparent ring-1 ring-inset ring-neutral-700"
                            )}
                          />
                          <AdThumb thumb={s.thumb} full={s.image} name={s.adName} />
                          <div className="min-w-0">
                            <span className="block max-w-[240px] truncate text-neutral-200" title={s.adName}>{s.adName}</span>
                            {s.lastLeadAt > 0 && (
                              <span className="text-[11px] text-neutral-600" title={`Most recent lead ${fmtDate(new Date(s.lastLeadAt).toISOString())}`}>
                                last lead {ageShort(new Date(s.lastLeadAt).toISOString())}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-neutral-300" data-mlabel="Spend">{fmtEur(s.spend, 0)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-neutral-300" data-mlabel="Leads">{s.total}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-neutral-300" data-mlabel="CPL">{fmtEur(s.cpl, 2)}</td>
                      <td className={cn("px-4 py-2.5 text-right tabular-nums", s.qualified > 0 ? "text-emerald-300" : "text-neutral-600")} data-mlabel="Qualified">{s.qualified}</td>
                      <td className={cn("px-4 py-2.5 text-right tabular-nums", s.unqualified > 0 ? "text-rose-300" : "text-neutral-600")} data-mlabel="Unqualified">{s.unqualified}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500" data-mlabel="Pending" data-mhide="1">{s.pending}</td>
                      <td className={cn("px-4 py-2.5 text-right tabular-nums", s.cpq != null ? "text-neutral-100" : "text-neutral-600")} data-mlabel="Cost / qualified">{fmtEur(s.cpq, 2)}</td>
                      <td className="pl-4 pr-5 py-2.5" data-mlabel="Qualified rate">
                        <RateBar r={r} qualified={s.qualified} decided={decided(s)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </section>
          )}
        </>
      )}

      {view !== "ads" && (
        <>
          {/* Empty Tasks queue shows no toolbar — tabs + search over zero rows are dead controls (M13). */}
          {!(view === "tasks" && taskCounts.total === 0) && (
          <>
          {/* min-h matches the Ad-quality toolbar row exactly, so the first buttons of every view
              start at the same x AND sit on the same baseline when switching. */}
          <div className="flex min-h-[34px] flex-wrap items-center gap-3">
        {/* Boxed frame matching the Leads / Ad quality / Tasks switcher above, so the two toolbar rows read
            as one system; counts move into a small grey pill instead of being baked into the label. */}
        <div className="no-scrollbar -mx-1 flex w-full gap-0.5 overflow-x-auto px-1 sm:mx-0 sm:w-auto sm:rounded-md sm:border sm:border-neutral-800 sm:bg-panel sm:p-0.5">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setStatus(t.key)}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-3 text-xs font-medium transition-colors",
                status === t.key ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"
              )}
            >
              {t.label}
              <span
                className={cn("inline-flex justify-center rounded-full px-1.5 text-[11px] tabular-nums", status === t.key ? "bg-neutral-700/60 text-neutral-300" : "bg-surface-200 text-neutral-500")}
                style={{ minWidth: `calc(${t.digits}ch + 0.75rem)` }}
              >
                {t.count}
              </span>
            </button>
          ))}
        </div>
        {view === "leads" && (
          <AppSelect
            value={adFilter}
            onChange={setAdFilter}
            className="h-11 min-w-0 flex-1 sm:h-[34px] sm:max-w-[280px] sm:flex-none"
            options={[{ value: "all", label: "All sources" }, ...adOptions.map((o) => ({ value: o.id, label: o.name }))]}
          />
        )}
        {view === "leads" && (
          <AppSelect
            value={callFilter}
            onChange={setCallFilter}
            className="h-11 min-w-0 flex-1 sm:h-[34px] sm:max-w-[200px] sm:flex-none"
            options={[{ value: "all", label: "All call statuses" }, ...CALL_OPTIONS.map((o) => ({ value: o.value, label: o.label, dot: CALL_DOT[o.value] }))]}
          />
        )}
        {view === "leads" && (
          <button
            type="button"
            onClick={() => setUncontactedOnly(!uncontactedOnly)}
            title="Leads whose Call dropdown is still 'Not called'. Schedule no-answer retries into Tasks via the prompt or the clock button."
            className={cn(
              "inline-flex h-11 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none sm:h-7",
              uncontactedOnly
                ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                : "border-neutral-700 bg-surface-200 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", uncontactedOnly ? "bg-amber-400" : "bg-amber-500/70")} />
            To call ({uncontactedCount})
          </button>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, phone or email…"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          // order-first on a phone: searching is how you reach one person fastest on a small screen.
          // 16px text is deliberate — iOS zooms the whole page in when a focused input is below 16px.
          className="order-first h-11 w-full flex-1 rounded-md border border-neutral-700 bg-surface-200 px-3 text-base text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20 sm:order-none sm:h-[34px] sm:max-w-[360px] sm:text-sm"
        />
        <div className="ml-auto flex items-center gap-3">
          <span className="whitespace-nowrap text-xs text-neutral-500 tabular-nums">
            {filtered.length === leads.length ? `${leads.length} lead${leads.length === 1 ? "" : "s"}` : `${filtered.length} of ${leads.length}`}
          </span>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            title="Download every lead matching these filters as a CSV, including any not yet loaded below"
            className="hidden h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-surface-200 px-3 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100 disabled:opacity-50 sm:inline-flex"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
          <span className="text-xs font-medium text-neutral-200 tabular-nums">{selected.size} selected</span>
          {bulkProgress ? (
            <>
              <span className="text-xs tabular-nums text-neutral-300">Updating {bulkProgress.done}/{bulkProgress.total}…</span>
              <button
                type="button"
                onClick={() => { bulkCancelRef.current = true; }}
                className="ml-auto rounded-md border border-neutral-700 bg-surface-200 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">Set call</span>
              <BulkSelect label="Call state…" disabled={bulkBusy} options={CALL_OPTIONS} onPick={(v) => bulkApply("callState", v)} />
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">Qualify</span>
              <BulkSelect label="Qualification…" disabled={bulkBusy} options={QUAL_OPTIONS} onPick={(v) => bulkApply("qualification", v)} />
              <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-neutral-400 hover:text-neutral-200">
                Clear
              </button>
            </>
          )}
        </div>
      )}
      </>
      )}

      {/* CRM table */}
      {leads.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          No leads yet. When your ads collect leads they appear here automatically — or hit <span className="text-neutral-300">Refresh</span> to pull the latest from Meta now.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          {view === "tasks" && taskCounts.total === 0 ? (
            // Genuinely empty now means genuinely empty: never-called leads are IN this queue, so this
            // no longer claims "nothing left to do" while fresh leads sit uncalled one tab over.
            "Nothing to work — no open reminders and every lead has been dialled at least once."
          ) : (
            "No leads match these filters."
          )}
        </div>
      ) : (
        <div className="leads-scroll overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
          {/* table-fixed: column widths come from these <col>s, NOT from the visible rows' content.
              Without it the browser's auto-layout re-derives widths every time the row set changes
              (e.g. filtering to one ad), collapsing the flexible name column and wrapping names
              word-per-line. The Lead column has no fixed width so it absorbs the leftover — but the
              page container caps the whole table at its ideal width (leadsContentMaxWidth), so on a
              wide monitor Lead tops out at LEAD_MAX instead of ballooning. The rest are sized to their
              controls (widths shared from lib/leads-layout so the cap can't drift from the columns). */}
          <table className="leads-table w-full table-fixed text-sm" style={{ minWidth: tableMinW }}>
            <colgroup>
              <col style={{ width: LEADS_COLS.checkbox }} />
              <col />
              <col style={{ width: LEADS_COLS.company }} />
              <col style={{ width: LEADS_COLS.phone }} />
              <col style={{ width: LEADS_COLS.ad }} />
              <col style={{ width: LEADS_COLS.submitted }} />
              <col style={{ width: LEADS_COLS.call }} />
              <col style={{ width: LEADS_COLS.qual }} />
              <col style={{ width: LEADS_COLS.meeting }} />
              <col style={{ width: actionsW }} />
            </colgroup>
            <thead>
              <tr className="border-b border-neutral-800 bg-panel">
                <th className="pl-4 py-2.5 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all matching these filters"
                    checked={allFilteredSelected}
                    ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allFilteredSelected; }}
                    onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((l) => l.id)) : new Set())}
                    className="h-3.5 w-3.5 rounded border-neutral-600 bg-surface-200 text-accent focus:ring-accent/30"
                  />
                </th>
                <th className="pr-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Lead</th>
                <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Company</th>
                <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Phone</th>
                <th className="pl-6 pr-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">{view === "tasks" ? "Task" : "Source"}</th>
                <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">{view === "tasks" ? "Due" : "Submitted"}</th>
                <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Call</th>
                <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Qualification</th>
                <th className="px-4 py-2.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-neutral-500">Meeting</th>
                <th className="pr-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {visible.map((l, i) => {
                const isOpen = expanded === l.id;
                // Queue section headers: emitted in the Tasks view whenever the bucket changes. The rows
                // are already sorted by bucket, so a change of bucket IS a section boundary.
                const bucket = view === "tasks" ? bucketInfo.keyById.get(l.id) ?? null : null;
                const prevBucket = view === "tasks" && i > 0 ? bucketInfo.keyById.get(visible[i - 1].id) ?? null : null;
                const section = bucket && bucket !== prevBucket ? QUEUE_SECTIONS.find((x) => x.key === bucket) : null;
                const sectionCount = section ? bucketInfo.counts.get(section.key) ?? 0 : 0;
                return (
                  <FragmentRow
                    key={l.id}
                    view={view}
                    waTemplates={waTemplates}
                    sectionKey={section ? section.key : null}
                    sectionCount={sectionCount}
                    lead={l}
                    isOpen={isOpen}
                    onToggle={handleToggle}
                    canDelete={canDelete}
                    ghlConfigured={ghlConfigured}
                    hasAuditColumn={hasAudit}
                    selected={selected.has(l.id)}
                    onSelect={handleSelect}
                    onDelete={deleteLead}
                    onSaved={handleSaved}
                  />
                );
              })}
            </tbody>
          </table>
          {filtered.length > visible.length && (
            <div className="border-t border-neutral-800 px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE)}
                className="text-xs text-neutral-400 transition-colors hover:text-neutral-100"
              >
                Show {Math.min(PAGE, filtered.length - visible.length)} more
                <span className="ml-1.5 tabular-nums text-neutral-600">
                  ({filtered.length - visible.length} remaining)
                </span>
              </button>
            </div>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
}

/**
 * One lead row, its queue section header when it starts a group, and its expanded panel.
 *
 * Memoized: with the parent's patch overlay a change to one lead gives ONLY that lead a new object
 * identity, so a qualify click re-renders one row instead of all of them. This works only because
 * every callback prop is stable (handleToggle / handleSelect / handleSaved take the id as an argument
 * rather than closing over it) and the remaining props are primitives.
 */
const FragmentRow = memo(function FragmentRow({
  lead,
  isOpen,
  onToggle,
  canDelete,
  ghlConfigured,
  hasAuditColumn,
  selected,
  onSelect,
  onDelete,
  onSaved: onSavedRaw,
  waTemplates,
  view,
  sectionKey,
  sectionCount,
}: {
  lead: LeadView;
  isOpen: boolean;
  onToggle: (id: string) => void;
  canDelete: boolean;
  ghlConfigured: boolean;
  /** True when ANY lead in the table has an audit link — every row then reserves the slot so columns align. */
  hasAuditColumn: boolean;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onDelete: (lead: LeadView, alsoDeleteGhl: boolean) => Promise<boolean>;
  /** (id, errorNote, patch). Pass a patch when we know exactly what changed, so the whole table does
   *  not have to be re-fetched; pass neither to force a real refresh. */
  onSaved: (id: string, note: string | null, patch?: Partial<LeadView>) => void;
  /** WhatsApp template bodies from Settings (key → text), overriding the built-in defaults. */
  waTemplates: Record<string, unknown>;
  /** Which tab this row is rendered under. Only "tasks" changes anything — the Leads view is untouched. */
  view: "leads" | "ads" | "tasks";
  /** Set on the FIRST row of a queue section: renders the group header above this row. Passed as
   *  primitives, not an object, so memo's shallow compare doesn't fail on a fresh literal each render. */
  sectionKey: QueueKey | null;
  sectionCount: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [alsoGhl, setAlsoGhl] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingCompany, setEditingCompany] = useState(false); // Company cell's inline editor
  // Optimistic company while its PATCH (incl. the GHL write) is in flight; undefined = show the prop.
  const [pendingCompany, setPendingCompany] = useState<string | null | undefined>(undefined);
  const shownCompany = pendingCompany !== undefined ? pendingCompany : lead.company;
  // Optimistic local state for the qualify / call toggles — resynced to props after each server refresh.
  const [qual, setQual] = useState<Qualification>(lead.qualification);
  const [call, setCall] = useState<CallState>(lead.callState);
  const [attempts, setAttempts] = useState(lead.callAttempts);
  const [savingQual, setSavingQual] = useState(false);
  const [savingCall, setSavingCall] = useState(false);
  const [savingAttempt, setSavingAttempt] = useState(false);
  useEffect(() => setQual(lead.qualification), [lead.qualification]);
  useEffect(() => setCall(lead.callState), [lead.callState]);
  useEffect(() => setAttempts(lead.callAttempts), [lead.callAttempts]);
  // The lead's open GHL task (the pending to-do). Optimistic like qual/call; resynced from props.
  const [task, setTask] = useState<{ id: string; title: string; dueAt: string | null; count: number } | null>(
    lead.taskId ? { id: lead.taskId, title: lead.taskTitle ?? "Task", dueAt: lead.taskDueAt, count: lead.taskCount || 1 } : null
  );
  const [savingTask, setSavingTask] = useState(false);
  // Transient nudge after a call-state flip: offer to schedule a retry / follow-up / mark the task done.
  const [taskPrompt, setTaskPrompt] = useState<"retry" | "followup" | "done" | null>(null);
  const [pickDate, setPickDate] = useState(false); // the schedule prompt has swapped to the calendar
  const [waMenu, setWaMenu] = useState(false); // the WhatsApp template picker is open (desktop row chevron)
  const waMenuRef = useRef<HTMLButtonElement>(null);
  const [waMenuM, setWaMenuM] = useState(false); // the same picker, mobile expanded-panel version
  const [pushing, setPushing] = useState(false); // the queue's reschedule popover is open
  const [pushPick, setPushPick] = useState(false); // ...and has swapped to the calendar
  const pushBtnRef = useRef<HTMLButtonElement>(null);
  /** Only the Tasks tab changes shape — everything else renders exactly as it did. */
  const isQueue = view === "tasks";
  const [addingTask, setAddingTask] = useState(false);
  const [showNotes, setShowNotes] = useState(false); // notes-only popup (opened from the row chip)
  const [noteCount, setNoteCount] = useState(lead.notesCount); // drives the row chip; kept live by NotesSection
  useEffect(() => setNoteCount(lead.notesCount), [lead.notesCount]);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const callCellRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => setTask(lead.taskId ? { id: lead.taskId, title: lead.taskTitle ?? "Task", dueAt: lead.taskDueAt, count: lead.taskCount || 1 } : null),
    [lead.taskId, lead.taskTitle, lead.taskDueAt, lead.taskCount]
  );
  // The nudge below fires AFTER an await — read qual/task through refs so it sees the values as of the
  // response, not as of the render that created the closure (a concurrent qualify click would be missed).
  const qualRef = useRef(qual);
  const taskRef = useRef(task);
  useEffect(() => {
    qualRef.current = qual;
  }, [qual]);
  useEffect(() => {
    taskRef.current = task;
  }, [task]);
  const stop = (e: MouseEvent) => e.stopPropagation();
  /** Report upward with this row's id. `patch` = what we already know changed, so the parent can merge
   *  it instead of re-reading the whole table. */
  const onSaved = (note: string | null, patch?: Partial<LeadView>) => onSavedRaw(lead.id, note, patch);
  /** A tag change made while a nudge is open is held here and flushed when the nudge closes, so the
   *  prompt is never unmounted mid-interaction (same reason the refresh used to be deferred). */
  const pendingPatch = useRef<Partial<LeadView> | null>(null);
  // Action links off the phone number. Both are null when the number can't be trusted, so a malformed
  // import never renders a link that would open a chat with the wrong person.
  const phoneForLinks = lead.phone;
  const tel = telHref(phoneForLinks);
  /** wa.me link carrying one rendered template. Null when the number can't produce a safe link. */
  const waWith = (key: TemplateKey) =>
    waHref(
      phoneForLinks,
      renderTemplate(templateBody(key, waTemplates), {
        nome: firstName(lead.fullName),
        dia: lead.appointmentAt ? fmtApptDay(lead.appointmentAt) : null,
        hora: lead.appointmentAt ? fmtApptTime(lead.appointmentAt) : null,
      })
    );
  // The message that matches where this lead actually is, so the common case is one click.
  const suggestedKey = pickTemplate({
    callState: call,
    callAttempts: attempts,
    latestAttendance: lead.latestAttendance,
    appointmentAt: lead.appointmentAt,
  });
  // suggestedKey === null → we've already spoken to this lead and no template fits: open WhatsApp with
  // NO pre-filled text rather than putting a cold opener in his mouth.
  const wa = suggestedKey ? waWith(suggestedKey) : waHref(phoneForLinks);
  const suggested = suggestedKey ? WA_TEMPLATES.find((t) => t.key === suggestedKey) : null;

  // The WhatsApp template menu — shared by the desktop row chevron and the mobile expanded-panel picker,
  // so both reach all seven messages and both show the first line that will actually be SENT (not just the
  // state that triggers it — the trigger was invisible on touch, where the hover tooltip doesn't exist).
  const renderWaMenu = (close: () => void) =>
    WA_TEMPLATES.map((t) => {
      const href = waWith(t.key);
      if (!href) return null;
      const isSuggested = t.key === suggestedKey;
      const preview = renderTemplate(templateBody(t.key, waTemplates), {
        nome: firstName(lead.fullName),
        dia: lead.appointmentAt ? fmtApptDay(lead.appointmentAt) : null,
        hora: lead.appointmentAt ? fmtApptTime(lead.appointmentAt) : null,
      }).split("\n")[0];
      // "Confirmar reunião" / "Atraso na reunião" only make sense with a booked call behind them.
      if (t.needsMeeting && !lead.appointmentAt) {
        return (
          <span key={t.key} title="Sem reunião marcada para este lead" className="flex cursor-not-allowed flex-col gap-0.5 rounded px-2 py-1.5 opacity-40">
            <span className="flex items-center gap-1.5 text-xs text-neutral-100">
              <WhatsAppIcon className="h-3 w-3 shrink-0 text-neutral-500" />
              {t.label}
            </span>
            <span className="pl-[18px] text-[11px] text-neutral-500">sem reunião marcada</span>
          </span>
        );
      }
      return (
        <a
          key={t.key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { e.stopPropagation(); close(); }}
          title={preview}
          className={cn("flex min-w-0 flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-neutral-800", isSuggested && "bg-neutral-800/60")}
        >
          <span className="flex items-center gap-1.5 text-xs text-neutral-100">
            <WhatsAppIcon className="h-3 w-3 shrink-0 text-emerald-400" />
            {t.label}
            {isSuggested && <span className="text-[10px] uppercase tracking-wider text-emerald-400">sugerida</span>}
          </span>
          <span className="truncate pl-[18px] text-[11px] text-neutral-500">{preview}</span>
        </a>
      );
    });

  /** Create/complete/delete the lead's GHL task. OPTIMISTIC: the chip updates the instant the button is
   *  clicked (the server round-trip is GHL write + re-read + DB mirror — too slow to wait on), then
   *  reconciles to the server's answer (the contact's actual next open task) or rolls back on failure. */
  async function taskRequest(payload: Record<string, unknown>, optimistic: { id: string; title: string; dueAt: string | null; count: number } | null): Promise<boolean> {
    const before = task;
    setTask(optimistic);
    setSavingTask(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setTask(before);
        onSaved(j?.error || "Couldn't sync the task to GoHighLevel.");
        return false;
      }
      // The response carries the contact's real open-task count so "+N more" reconciles immediately
      // rather than waiting on the next sync (review 2026-07-20).
      const nextTask = j.task ? { id: j.task.id, title: j.task.title, dueAt: j.task.dueAt ?? null, count: j.task.count ?? 1 } : null;
      setTask(nextTask);
      // The task columns drive the queue's membership, buckets and counts, so the parent must see them.
      // Any tag change held back by an open nudge rides along here.
      const held = pendingPatch.current;
      pendingPatch.current = null;
      onSaved(null, {
        ...held,
        taskId: nextTask?.id ?? null,
        taskTitle: nextTask?.title ?? null,
        taskDueAt: nextTask?.dueAt ?? null,
        taskCount: nextTask?.count ?? 0,
      });
      return true;
    } catch {
      setTask(before);
      onSaved("Couldn't reach the server.");
      return false;
    } finally {
      setSavingTask(false);
    }
  }
  const createTask = (title: string, dueAt: Date) =>
    // Optimistic count: one more open task than there are RIGHT NOW. Read through taskRef, not the
    // render-scope `task` — an undo fires from a closure minted before the delete, where `task` still
    // holds the deleted one, and the chip would briefly claim a count that was never true.
    taskRequest(
      { createTask: { title, dueAt: dueAt.toISOString() } },
      { id: "pending", title, dueAt: dueAt.toISOString(), count: (taskRef.current?.count ?? 0) + 1 }
    );
  const completeTask = () => (task ? taskRequest({ completeTask: task.id }, null) : Promise.resolve(false));
  /** Move an existing reminder to a new day — same GHL task, new due date. Before this existed the only
   *  way to postpone was delete + re-create, so operators deleted reminders and leads left every queue. */
  const rescheduleTask = (dueAt: Date) =>
    task
      ? taskRequest(
          { rescheduleTask: { id: task.id, title: task.title, dueAt: dueAt.toISOString() } },
          { id: task.id, title: task.title, dueAt: dueAt.toISOString(), count: task.count }
        )
      : Promise.resolve(false);
  /**
   * Delete is one click with no confirm and it destroys the GHL task outright (unlike "Mark done",
   * which keeps it as completed). Undo is the safety net: capture title + due BEFORE the request, then
   * offer a re-create. The restored task is a NEW GHL task (new id) — fine, since what matters is the
   * reminder existing. A due date now in the past is clamped to today 10:00, which the server requires.
   */
  const deleteTask = async () => {
    if (!task) return false;
    const gone = { title: task.title, dueAt: task.dueAt };
    const ok = await taskRequest({ deleteTask: task.id }, null);
    if (ok) {
      toast(`Task deleted — ${gone.title}`, "success", {
        actionLabel: "Undo",
        duration: 8000,
        onAction: () => {
          const orig = gone.dueAt ? new Date(gone.dueAt) : null;
          const due = orig && orig.getTime() > Date.now() ? orig : dueToday();
          void createTask(gone.title, due);
        },
      });
    }
    return ok;
  };
  /** Dismissing an open nudge fires the parent refresh that saveTag deferred while the prompt was up. */
  const dismissPrompt = () => {
    setTaskPrompt(null);
    setPickDate(false);
    const held = pendingPatch.current;
    pendingPatch.current = null;
    onSaved(null, held ?? undefined);
  };
  /** Quick-pick due dates land at 10:00 local — a callable morning slot, not midnight. */
  const at10 = (d: Date) => {
    d.setHours(10, 0, 0, 0);
    return d;
  };
  const dueToday = () => at10(new Date());
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }; // calendar floor — no scheduling in the past
  const dueTomorrow = () => at10(new Date(Date.now() + 86_400_000));
  const dueMonday = () => {
    const d = new Date();
    d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
    return at10(d);
  };
  /** Mirrors the server rule: flipping INTO a dial-outcome state counts as a call attempt. */
  const countsAsDial = (next: CallState, prev: CallState) =>
    next !== prev && (next === "contacted" || next === "no_answer" || next === "invalid_phone");

  // Qualify / call state live as GoHighLevel tags. Optimistically flip locally, PATCH (server writes GHL
  // first), then reconcile on refresh; revert + surface the error if GHL rejected it.
  async function saveTag(
    kind: "qualification" | "callState",
    next: Qualification | CallState,
    prev: Qualification | CallState,
    apply: (v: any) => void,
    setSaving: (b: boolean) => void
  ) {
    apply(next);
    // Offer the follow-up nudge IMMEDIATELY, like the optimistic state flip itself — waiting for the
    // server round-trip made the prompt pop in late and feel detached. Rolled back if the save fails.
    // UN-GATED from qualification (audit 2026-07-20): every no-answer without a task gets the offer —
    // the operator decides; before, non-qualified no-answers silently left every queue (~14 leads
    // written off after one dial). Follow-up REQUIRES a date to mean anything, so it prompts too.
    let openedPrompt = false;
    if (kind === "callState") {
      if (next === "no_answer" && !taskRef.current) { setTaskPrompt("retry"); openedPrompt = true; }
      else if (next === "follow_up" && !taskRef.current) { setTaskPrompt("followup"); openedPrompt = true; }
      else if ((next === "contacted" || next === "invalid_phone") && taskRef.current) { setTaskPrompt("done"); openedPrompt = true; }
      else setTaskPrompt(null);
    }
    const dialed = kind === "callState" && countsAsDial(next as CallState, prev as CallState);
    if (dialed) setAttempts((a) => a + 1);
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [kind]: next }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        apply(prev);
        if (kind === "callState") setTaskPrompt(null); // the state flip failed — the offer no longer applies
        if (dialed) setAttempts((a) => a - 1);
        onSaved(j?.error || "Couldn't sync to GoHighLevel.");
      } else {
        // What we know changed, so the parent can merge it instead of re-reading the whole table.
        // Prefer the server's re-derived values over the optimistic guess: it computes qualification /
        // call state from the REAL returned GHL tag list (a manually-added variant tag is reflected, not
        // just the button's intent) and attempts from the DB's current count. A dial doesn't refresh the
        // table, so the optimistic value would otherwise persist on screen until an unrelated refresh.
        const patch: Partial<LeadView> =
          kind === "qualification"
            ? { qualification: (j.qualification as Qualification) ?? (next as Qualification) }
            : {
                callState: (j.callState as CallState) ?? (next as CallState),
                ...(typeof j.attempts === "number" ? { callAttempts: j.attempts } : dialed ? { callAttempts: attempts + 1 } : {}),
                // A dial also stamps the attempt time server-side; mirror it so the recency badge doesn't
                // keep showing the PREVIOUS dial's age until the next real refresh.
                ...(dialed ? { lastCallAttemptAt: new Date().toISOString() } : {}),
              };
        // Clicking the ALREADY-selected Qualified/Unqualified button clears the lead back to Pending —
        // a gesture pixel-identical to selecting it, 4px from the other button, that strips the tag in
        // GoHighLevel. Undo restores it. Additive only: no markup, no button, no layout touched.
        if (kind === "qualification" && next === "pending" && prev !== "pending") {
          toast(`Qualification cleared (was ${prev})`, "success", {
            actionLabel: "Undo",
            duration: 8000,
            onAction: () => void saveTag("qualification", prev, "pending", apply, setSaving),
          });
        }
        // openedPrompt: HOLD the patch. Applying it now re-evaluates `filtered` and, with the To-call
        // filter on, drops this row and unmounts the nudge mid-interaction. The prompt's answer or its
        // dismissal flushes it (same reason the refresh used to be deferred, review 2026-07-20).
        if (openedPrompt) pendingPatch.current = { ...pendingPatch.current, ...patch };
        else onSaved(null, patch);
      }
      // openedPrompt: DEFER the refresh — with the To-call filter on, refreshed props would drop this
      // row from the table and unmount the prompt mid-interaction (review 2026-07-20). The prompt's
      // answer (taskRequest) or dismissal (dismissPrompt) triggers the refresh instead.
    } catch {
      apply(prev);
      if (kind === "callState") setTaskPrompt(null);
      if (dialed) setAttempts((a) => a - 1);
      onSaved("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }
  const tagDisabled = !ghlConfigured || !lead.matched;
  const tagHint = !ghlConfigured
    ? "Connect GoHighLevel to set this"
    : "Syncs once this lead is matched to a GoHighLevel contact";
  /** Manual counter adjust: +1 = another dial, same outcome; -1 = undo a mis-count. Floored at 0. */
  async function logAttempt(e: MouseEvent, delta: 1 | -1) {
    stop(e);
    const prev = attempts;
    const next = Math.max(0, prev + delta);
    if (next === prev) return; // minus at 0 — nothing to undo
    setAttempts(next);
    setSavingAttempt(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logCallAttempt: delta }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setAttempts(prev);
        onSaved(j?.error || "Couldn't save the attempt.");
      } else {
        // Only a +1 is a dial; a -1 is a correction and the server deliberately leaves the time alone.
        onSaved(null, { callAttempts: typeof j.attempts === "number" ? j.attempts : next, ...(delta > 0 ? { lastCallAttemptAt: new Date().toISOString() } : {}) });
      }
    } catch {
      setAttempts(prev);
      onSaved("Couldn't reach the server.");
    } finally {
      setSavingAttempt(false);
    }
  }
  async function doDelete(e: MouseEvent) {
    stop(e);
    setDeleting(true);
    await onDelete(lead, alsoGhl && !!lead.ghlContactUrl);
    // On success the row is removed by the parent's refresh; on failure re-enable the controls.
    setDeleting(false);
    setConfirming(false);
  }
  /** PATCH contact fields; the server writes GHL first, so an error here means nothing changed anywhere. */
  async function saveFields(patch: Record<string, string>): Promise<string | null> {
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) return j?.error || "Save failed.";
      // `note` here rides a SUCCESS ("saved, but the lead isn't linked to GoHighLevel yet"). It is
      // information, not a failure, so it must not go down the error path — and the refresh must still
      // happen or the row keeps rendering the old value.
      if (j.note) toast(j.note);
      onSaved(null);
      return null;
    } catch {
      return "Save failed.";
    }
  }
  const saveField = (key: "phone" | "email" | "website" | "additionalEmail" | "additionalPhone" | "company", value: string) => saveFields({ [key]: value });
  // Company gets its own save path: optimistic display + toast on failure + a PATCH-overlay success
  // (no full-table refresh) — the generic saveFields would show the stale name for the whole GHL round
  // trip and silently swallow errors (review finds).
  async function saveCompany(v: string): Promise<string | null> {
    setPendingCompany(v || null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: v }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setPendingCompany(undefined);
        toast(j?.error || "Couldn't save the company.", "error");
        return j?.error || "Couldn't save the company.";
      }
      if (j.note) toast(j.note);
      onSaved(null, { company: v || null });
      setPendingCompany(undefined);
      return null;
    } catch {
      setPendingCompany(undefined);
      toast("Couldn't save the company.", "error");
      return "Couldn't save the company.";
    }
  }
  const totalCols = 10; // the colgroup emits 10 columns in both the audit and non-audit variants
  const section = sectionKey ? QUEUE_SECTIONS.find((x) => x.key === sectionKey) ?? null : null;
  return (
    <>
      {/* Queue section header. Rendered only in the Tasks tab, only on the first row of each group, so
          "what have I already missed" and "what isn't due yet" stop looking identical. */}
      {section && (
        <tr className="m-section bg-neutral-950/40">
          <td colSpan={totalCols} className="border-b border-t border-neutral-800 px-4 py-1.5 first:border-t-0">
            <span className={cn("font-mono text-[11px] uppercase tracking-wider", section.tone)}>{section.label}</span>
            <span className="ml-2 text-[11px] tabular-nums text-neutral-600">
              {sectionCount} · {section.hint}
            </span>
          </td>
        </tr>
      )}
      <tr
        className={cn(
          // last:border-b-0 (NOT last:border-0) — border-0 zeroes ALL sides and, via :last-child
          // specificity, would kill the amber left rail on the LAST row (bug caught 2026-07-20).
          "group cursor-pointer border-b border-neutral-800 last:border-b-0 hover:bg-surface-200/50",
          // Amber rail = NOT YET CALLED. Miguel's rule (2026-07-20): purely about the Call dropdown —
          // glows until the operator moves it off "Not called". Qualification does NOT clear it, nor a
          // booked meeting. The amber WASH is suppressed when the row is open or selected so those two
          // states own the background without colliding (M11); the left rail stays either way.
          call === "none" && "border-l-2 border-l-amber-500/70",
          call === "none" && !isOpen && !selected && "bg-amber-500/[0.04]",
          selected && !isOpen && "bg-accent/[0.06]",
          isOpen && "border-b-0 bg-neutral-900"
        )}
        onClick={() => onToggle(lead.id)}
      >
        <td className="pl-4 py-2.5" data-mhide="1" onClick={stop}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(lead.id, e.target.checked)}
            aria-label={`Select ${lead.fullName ?? "lead"}`}
            className="h-3.5 w-3.5 rounded border-neutral-600 bg-surface-200 text-accent focus:ring-accent/30"
          />
        </td>
        <td className="pr-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {/* Audit stage as a leading icon so the NAME keeps the column width (user 2026-07-20). */}
            {lead.stage && <StageDot stage={lead.stage} />}
            {lead.fullName ? (
              <span className="truncate font-medium text-neutral-100" title={lead.fullName}>{lead.fullName}</span>
            ) : (
              <span className="font-medium text-rose-400/90">Missing</span>
            )}
            {/* Lead age on still-uncalled rows — how long this lead has been waiting for a first call. */}
            {call === "none" && lead.createdTime && (
              <span className="shrink-0 text-[11px] tabular-nums text-neutral-600" title={`Submitted ${fmtDate(lead.createdTime)}`}>{ageShort(lead.createdTime)}</span>
            )}
            {task && <TaskChip title={task.title} dueAt={task.dueAt} extra={task.count > 1 ? task.count - 1 : 0} />}
            {lead.duplicateCount > 1 && (
              <span
                title={`This person appears ${lead.duplicateCount} times (same phone or email) — check before counting them twice`}
                className="inline-flex h-5 shrink-0 items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] font-medium text-amber-300"
              >
                ×{lead.duplicateCount}
              </span>
            )}
            {/* Notes button — one fixed 24px square on EVERY row (same size with or without notes, only
                the colour differs: accent = has notes, neutral = none yet). Opens the notes-only popup;
                the count lives in the tooltip. */}
            <button
              ref={notesBtnRef}
              type="button"
              onClick={(e) => { stop(e); setShowNotes((s) => !s); }}
              title={noteCount > 0 ? `${noteCount} note${noteCount === 1 ? "" : "s"} — click to view` : "Add a note"}
              aria-label={noteCount > 0 ? "View notes" : "Add a note"}
              className={cn(
                "note-chip inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors",
                noteCount > 0
                  ? showNotes
                    ? "border-accent/60 bg-accent/20 text-accent"
                    : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
                  : showNotes
                    ? "border-neutral-600 bg-surface-200 text-neutral-200"
                    : "border-neutral-700 bg-surface-200 text-neutral-500 hover:text-neutral-200"
              )}
            >
              <NoteIcon className="h-4 w-4" />
            </button>
            {showNotes && notesBtnRef.current && (
              <FloatingPrompt anchor={notesBtnRef.current} onClose={() => setShowNotes(false)} bodyClassName="p-3 w-[360px]" excludeAnchor>
                <div onClick={stop} className="w-full">
                  <NotesSection
                    leadId={lead.id}
                    initialNotes={lead.notesCache ?? (noteCount === 0 ? [] : null)}
                    onCountChange={setNoteCount}
                    onSync={(ns) => onSaved(null, { notesCache: ns, notesCount: ns.length })}
                    className=""
                  />
                </div>
              </FloatingPrompt>
            )}
          </div>
        </td>
        {/* Company — extracted from the lead's website by the sync; sits right after the name.
            Click-to-edit: saves locally AND into GHL's native Company Name field (Miguel, 2026-07-23);
            a manual value wins over the extractor forever. */}
        <td className="px-4 py-2.5 text-neutral-300" data-mlabel="Company" onClick={stop}>
          {editingCompany ? (
            <input
              autoFocus
              defaultValue={shownCompany ?? ""}
              maxLength={120}
              placeholder="Company name"
              className={EDIT_INPUT_CLASS}
              onBlur={(e) => {
                setEditingCompany(false);
                const v = e.target.value.trim();
                if (v !== (shownCompany ?? "")) void saveCompany(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditingCompany(false); // unmount without blur-save
              }}
            />
          ) : (
            <button
              type="button"
              className="group/comp flex w-full min-w-0 items-center gap-1.5 text-left"
              title={shownCompany ? `${shownCompany} — click to edit` : "Set the company"}
              onClick={(e) => { stop(e); setEditingCompany(true); }}
            >
              <span className="min-w-0 truncate">{shownCompany || <span className="text-neutral-600">—</span>}</span>
              <PencilIcon className="h-3 w-3 shrink-0 text-neutral-600 opacity-0 transition-opacity group-hover/comp:opacity-100" />
            </button>
          )}
        </td>
        {/* Phone. onClick={stop} so selecting/copying the number no longer toggles the row open.
            The action links are IN THE FLOW (not absolutely positioned): they are always laid out and
            merely fade in on hover, so they reserve their own space and can never sit on top of the
            number at any column width or zoom level. The number truncates instead of colliding.
            Dial is md:hidden — on a desktop a tel: link does nothing useful, on his phone it dials. */}
        <td className="px-4 py-2.5 text-neutral-300" data-mlabel="Phone" onClick={stop}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate tabular-nums" title={lead.phone ?? undefined}>
              {lead.phone || <span className="text-rose-400/90">Missing</span>}
            </span>
            {(wa || tel) && (
              <span className="leads-phone-actions ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {tel && (
                <a
                  href={tel}
                  title={`Call ${lead.phone}`}
                  aria-label="Call this lead"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-surface-200 text-neutral-400 transition-colors hover:text-neutral-100 md:hidden"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                </a>
              )}
              {wa && (
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={suggested ? `WhatsApp — ${suggested.label} (${suggested.when})` : "WhatsApp — chat vazio (já falaste com este lead)"}
                  aria-label="Message this lead on WhatsApp"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 transition-colors hover:bg-emerald-500/20"
                >
                  <WhatsAppIcon className="h-4 w-4" />
                </a>
                )}
                {/* The suggested message is one click; this opens the other six. */}
                {wa && (
                  <button
                    ref={waMenuRef}
                    type="button"
                    title="Escolher outra mensagem"
                    aria-label="Choose a WhatsApp message"
                    onClick={(e) => { stop(e); setWaMenu((v) => !v); }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-700 bg-surface-200 text-neutral-400 transition-colors hover:text-neutral-100"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                )}
              </span>
            )}
          </div>
          {waMenu && waMenuRef.current && (
            <FloatingPrompt anchor={waMenuRef.current} onClose={() => setWaMenu(false)} excludeAnchor bodyClassName="p-1 w-[260px]">
              <div className="flex w-full flex-col">{renderWaMenu(() => setWaMenu(false))}</div>
            </FloatingPrompt>
          )}
        </td>
        {/* Ad / Submitted in the Leads view — TASK / DUE in the queue. Same two <td>s and the same
            column widths, so the Leads view renders byte-identically to before; only the Tasks tab
            trades "which ad, submitted when" (not what you act on) for "what do I owe, and when". */}
        {isQueue ? (
          <>
            <td className="pl-6 pr-4 py-2.5" data-mlabel="Task" onClick={stop}>
              {task ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-neutral-200" title={task.title}>{task.title}</span>
                  {task.count > 1 && (
                    <span className="shrink-0 text-[11px] tabular-nums text-neutral-500" title={`${task.count} open tasks on this contact`}>
                      +{task.count - 1}
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-neutral-500">First call</span>
              )}
            </td>
            <td className="px-4 py-2.5 whitespace-nowrap" data-mlabel="Due" onClick={stop}>
              {task ? (
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "tabular-nums",
                      dueInfo(task.dueAt).tone === "overdue"
                        ? "text-rose-300"
                        : dueInfo(task.dueAt).tone === "today"
                          ? "text-amber-300"
                          : "text-neutral-400"
                    )}
                    title={task.dueAt ? fmtDate(task.dueAt) : "No due date"}
                  >
                    {dueInfo(task.dueAt).label}
                  </span>
                  {/* Work the queue WITHOUT opening each row: tick it off, or push it to another day.
                      Both were previously buried behind a row expansion — and rescheduling didn't exist
                      at all, so the only way to postpone was to delete the reminder. */}
                  <button
                    type="button"
                    disabled={savingTask}
                    title="Mark done — stays in GoHighLevel as completed"
                    aria-label="Mark task done"
                    onClick={(e) => { stop(e); void completeTask(); }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-700 text-neutral-400 transition-colors hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-50"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </button>
                  <button
                    type="button"
                    ref={pushBtnRef}
                    disabled={savingTask}
                    title="Move to another day"
                    aria-label="Reschedule task"
                    onClick={(e) => { stop(e); setPushing((v) => !v); }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-700 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100 disabled:opacity-50"
                  >
                    <ClockIcon className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <span className="whitespace-nowrap text-neutral-500" title={`Submitted ${fmtDate(lead.createdTime)}`}>
                  waiting {ageShort(lead.createdTime)}
                </span>
              )}
            </td>
          </>
        ) : (
          <>
            <td className="pl-6 pr-4 py-2.5" data-mlabel="Source">
              <div className="flex min-w-0 items-center gap-2">
                {(() => {
                  // Every non-ad lead shows its source glyph + label (an unattributed website lead IS
                  // Organic — "direct" is no longer a thing); only genuine ad leads show the creative.
                  const ob = outboundFor(lead);
                  return ob ? (
                    <>
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-neutral-800" title={ob.label}>
                        <OutboundIcon source={ob.source} className="h-3.5 w-3.5 text-neutral-400" />
                      </span>
                      <span className="truncate text-neutral-300" title={ob.label}>{ob.label}</span>
                    </>
                  ) : (
                    <>
                      <AdThumb thumb={lead.adThumbUrl} full={lead.adImageUrl} name={lead.adName} />
                      <span className="truncate text-neutral-300" title={lead.adName ?? undefined}>{lead.adName || "Ad — unknown"}</span>
                    </>
                  );
                })()}
              </div>
            </td>
            <td className="px-4 py-2.5 whitespace-nowrap text-neutral-400" data-mlabel="Submitted">{fmtDate(lead.createdTime)}</td>
          </>
        )}
        <td className="px-4 py-2.5" data-mlabel="Call" onClick={stop}>
          <div ref={callCellRef} className="flex flex-wrap items-center gap-2">
            <CallSelect
              value={call}
              onChange={(next) => saveTag("callState", next, call, (v) => setCall(v), setSavingCall)}
              busy={savingCall}
              disabled={tagDisabled}
              disabledHint={tagHint}
            />
            {/* Attempts counter — ALWAYS shown so a call can be logged from ANY state, and it ALWAYS
                looks identical whether or not the clock follows it (Miguel 2026-07-20). Count at one
                constant brightness (shows 0 when never called). Minus disabled at 0 so it can't go
                negative. Its own connected pill: [📞 count | − | +]. */}
            <div className="m-stepper inline-flex items-stretch overflow-hidden whitespace-nowrap rounded-md border border-neutral-700">
              <span
                title={
                  attempts === 0
                    ? "No calls logged yet"
                    : `Called ${attempts} time${attempts === 1 ? "" : "s"}${lead.lastCallAttemptAt ? ` — last tried ${fmtDate(lead.lastCallAttemptAt)}` : ""}`
                }
                className="inline-flex h-7 items-center gap-1 px-1.5 text-xs font-medium tabular-nums text-neutral-200"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
                {attempts}
                {/* Call RECENCY — "2 · 3d" answers "when did we last try?", the number alone can't.
                    last_call_attempt_at was stored + loaded but never rendered until now (audit 02/50). */}
                {attempts > 0 && lead.lastCallAttemptAt && (
                  <span className="text-neutral-500">· {ageShort(lead.lastCallAttemptAt)}</span>
                )}
              </span>
              <button
                type="button"
                onClick={(e) => logAttempt(e, -1)}
                disabled={savingAttempt || attempts === 0}
                title="Remove one call — undo a mis-count"
                className="inline-flex h-7 w-6 items-center justify-center border-l border-neutral-700 text-neutral-500 transition-colors hover:bg-surface-200 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <MinusIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => logAttempt(e, 1)}
                disabled={savingAttempt}
                title="Log one more call to this lead"
                className="inline-flex h-7 w-6 items-center justify-center border-l border-neutral-700 text-neutral-500 transition-colors hover:bg-surface-200 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Schedule / retry button — a COMPLETELY SEPARATE button AFTER the counter (Miguel
                2026-07-20), never touching it. Its own bordered square, gap-2 away. Appears only when
                there's something to schedule (no-answer / follow-up) with nothing queued yet: the
                retry black hole. */}
            {!task && !taskPrompt && (call === "no_answer" || call === "follow_up") && (
              <button
                type="button"
                onClick={() => setTaskPrompt(call === "no_answer" ? "retry" : "followup")}
                disabled={tagDisabled || savingTask}
                title={call === "no_answer" ? "Nothing scheduled — plan the retry call" : "Nothing scheduled — pick the follow-up date"}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-700 text-amber-400 transition-colors hover:bg-surface-200 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ClockIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* Reschedule popover — Tasks tab only. Same react-day-picker calendar as everywhere else. */}
          {pushing && task && pushBtnRef.current && (
            <FloatingPrompt
              anchor={pushBtnRef.current}
              onClose={() => { setPushing(false); setPushPick(false); }}
              excludeAnchor
              bodyClassName={pushPick ? "p-2" : "flex items-center gap-1.5 px-2 py-1.5"}
            >
              {pushPick ? (
                <DayPicker
                  mode="single"
                  weekStartsOn={1}
                  disabled={{ before: startOfToday() }}
                  defaultMonth={task.dueAt ? new Date(task.dueAt) : new Date()}
                  onSelect={(day) => {
                    if (!day) return;
                    day.setHours(10, 0, 0, 0);
                    setPushPick(false);
                    setPushing(false);
                    void rescheduleTask(day);
                  }}
                />
              ) : (
                <>
                  <span className="whitespace-nowrap text-xs text-neutral-300">Move to</span>
                  <button type="button" className={PROMPT_BTN} disabled={savingTask} onClick={() => { setPushing(false); void rescheduleTask(dueToday()); }}>
                    Today
                  </button>
                  <button type="button" className={PROMPT_BTN} disabled={savingTask} onClick={() => { setPushing(false); void rescheduleTask(dueTomorrow()); }}>
                    Tomorrow
                  </button>
                  <button type="button" className={PROMPT_BTN} disabled={savingTask} onClick={() => { setPushing(false); void rescheduleTask(dueMonday()); }}>
                    Monday
                  </button>
                  <button type="button" className={PROMPT_BTN} disabled={savingTask} onClick={() => setPushPick(true)}>
                    Pick a date
                  </button>
                </>
              )}
            </FloatingPrompt>
          )}
          {taskPrompt && callCellRef.current && pickDate && (
            // Same react-day-picker calendar as the Ads Manager "Custom range" — single-date mode,
            // globally themed (.rdp-* in globals.css). Picking a day schedules the task at 10:00.
            <FloatingPrompt anchor={callCellRef.current} onClose={dismissPrompt} bodyClassName="p-2">
              <DayPicker
                mode="single"
                weekStartsOn={1}
                disabled={{ before: startOfToday() }}
                defaultMonth={new Date()}
                onSelect={(day) => {
                  if (!day) return;
                  day.setHours(10, 0, 0, 0);
                  const title = taskPrompt === "retry" ? "Call again" : "Follow up";
                  setPickDate(false);
                  setTaskPrompt(null);
                  void createTask(title, day);
                }}
              />
            </FloatingPrompt>
          )}
          {taskPrompt && callCellRef.current && !pickDate && (
            <FloatingPrompt anchor={callCellRef.current} onClose={dismissPrompt}>
              {taskPrompt !== "done" ? (
                <>
                  <span className="whitespace-nowrap text-xs text-neutral-300">
                    {taskPrompt === "retry" ? "Schedule a retry call?" : "Schedule the follow-up?"}
                  </span>
                  <button
                    type="button"
                    className={PROMPT_BTN}
                    disabled={savingTask}
                    onClick={() => { setTaskPrompt(null); void createTask(taskPrompt === "retry" ? "Call again" : "Follow up", dueToday()); }}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className={PROMPT_BTN}
                    disabled={savingTask}
                    onClick={() => { setTaskPrompt(null); void createTask(taskPrompt === "retry" ? "Call again" : "Follow up", dueTomorrow()); }}
                  >
                    Tomorrow
                  </button>
                  <button
                    type="button"
                    className={PROMPT_BTN}
                    disabled={savingTask}
                    onClick={() => setPickDate(true)}
                  >
                    Pick a date
                  </button>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    className="px-1 text-sm leading-none text-neutral-500 transition-colors hover:text-neutral-200"
                    onClick={dismissPrompt}
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <span className="whitespace-nowrap text-xs text-neutral-300">
                    Task done{task ? ` — “${task.title}”` : ""}?
                  </span>
                  <button
                    type="button"
                    className={PROMPT_BTN}
                    disabled={savingTask}
                    onClick={() => { setTaskPrompt(null); void completeTask(); }}
                  >
                    Mark done
                  </button>
                  <button
                    type="button"
                    className="text-xs text-neutral-400 transition-colors hover:text-neutral-200"
                    onClick={dismissPrompt}
                  >
                    Keep
                  </button>
                </>
              )}
            </FloatingPrompt>
          )}
        </td>
        <td className="px-4 py-2.5" data-mlabel="Qualification" onClick={stop}>
          <div className="flex items-center gap-1.5">
            <StateToggle<Qualification>
              value={qual}
              neutral="pending"
              options={[
                { key: "qualified", label: "Qualified", tone: "good", title: "Made it to a Google Meet" },
                { key: "unqualified", label: "Unqualified", tone: "danger", title: "Never reached a Google Meet — writes the 'unqualified' tag in GHL (post-meet disqualification is a separate stage, managed in GHL)" },
              ]}
              onChange={(next) => saveTag("qualification", next, qual, (v) => setQual(v), setSavingQual)}
              busy={savingQual}
              disabled={tagDisabled}
              disabledHint={tagHint}
            />
          </div>
        </td>
        {/* Meeting — its own column so a booked-call chip can never overlap the Actions links. Empty
            (a subtle em-dash) when nothing is scheduled. */}
        {/* Meeting. Hidden on a phone when there is nothing to show: an em-dash under a "MEETING"
            label is a whole card row spent saying nothing. */}
        <td className="px-4 py-2.5" data-mlabel="Meeting" data-mhide={lead.appointmentAt ? undefined : "1"} onClick={stop}>
          {lead.appointmentAt ? (
            ghlConfigured && lead.matched ? (
              <MeetingChipButton lead={lead} onSaved={onSaved} />
            ) : (
              <ApptChip at={lead.appointmentAt} status={lead.appointmentStatus} title={lead.appointmentTitle} attendance={lead.apptAttendance ?? lead.latestAttendance} needsConfirm={leadNeedsConfirmation(lead)} needsRebook={lead.needsRebook} />
            )
          ) : (
            <span className="text-neutral-700">—</span>
          )}
        </td>
        <td className="pl-4 pr-5 py-2.5 text-right" data-mlabel="Actions">
          {confirming ? (
            <div className="flex items-center justify-end gap-2" onClick={stop}>
              {ghlConfigured && lead.ghlContactUrl && (
                <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-neutral-400" title="Also permanently delete this contact from GoHighLevel">
                  <input type="checkbox" checked={alsoGhl} onChange={(e) => setAlsoGhl(e.target.checked)} className="h-3.5 w-3.5 rounded border-neutral-600 bg-surface-200 text-rose-500 focus:ring-rose-500/30" />
                  also GHL
                </label>
              )}
              <button
                onClick={doDelete}
                disabled={deleting}
                className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
              >
                {deleting && <span className="h-3 w-3 animate-spin rounded-full border border-rose-400/40 border-t-rose-300" />}
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button onClick={(e) => { stop(e); setConfirming(false); }} disabled={deleting} className="whitespace-nowrap text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50">
                Cancel
              </button>
            </div>
          ) : (
            // Fixed-width slots so every action sits in the same visual column on every row — the chip's
            // text varies ("3 answers" vs "Details") and the links aren't always present, but the slots are.
            <div className="flex items-center justify-end gap-3">
              {hasAuditColumn && (
                <span className="w-14 whitespace-nowrap text-right">
                  {lead.auditUrl && (
                    <a
                      href={lead.auditUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-neutral-300 hover:text-neutral-100 hover:underline"
                      title="Open this lead's generated ROI audit"
                    >
                      Audit <ArrowUpRight className="h-3 w-3" />
                    </a>
                  )}
                </span>
              )}
              <span className="w-12 whitespace-nowrap text-right">
                {lead.ghlContactUrl && (
                  <a
                    href={lead.ghlContactUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline"
                    title="Open this contact in GoHighLevel"
                  >
                    GHL <ArrowUpRight className="h-3 w-3" />
                  </a>
                )}
              </span>
              {/* Real <button> (not a span) so it's keyboard-focusable and its role is honest — it toggles
                  the same expansion the row click does (M10). */}
              <button
                type="button"
                onClick={(e) => { stop(e); onToggle(lead.id); }}
                aria-expanded={isOpen}
                title={isOpen ? "Collapse" : "Expand lead details"}
                className="inline-flex h-7 w-[104px] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
              >
                {lead.answers.length > 0 ? `${lead.answers.length} ${lead.answers.length === 1 ? "answer" : "answers"}` : "Details"}
                <svg
                  className={cn("h-3 w-3 shrink-0 transition-transform", isOpen && "rotate-180")}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {canDelete && (
                <button
                  onClick={(e) => { stop(e); setConfirming(true); }}
                  title="Permanently delete this lead (removes it from every metric)"
                  className="w-11 whitespace-nowrap text-right text-xs text-neutral-500 transition-colors hover:text-rose-300"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
      {isOpen && (
        // Continue the amber "not called" rail onto the expanded panel so an open uncalled row reads as
        // one unit, not two halves with the rail stopping mid-way (review 2026-07-20).
        <tr className={cn("bg-neutral-950/60", call === "none" && "border-l-2 border-l-amber-500/70")}>
          <td colSpan={10} className="px-5 py-4">
            {/* PHONE ONLY. On a small screen the table collapses to the name column, so the controls
                that live in those hidden columns need a home. Same components and the same handlers as
                the row, so there is no second implementation to keep in step. md:hidden means the
                desktop panel is byte-identical to before. */}
            <div className="mb-4 flex flex-col gap-3 border-b border-neutral-800 pb-4 md:hidden" onClick={stop}>
              <div className="flex flex-wrap items-center gap-2">
                <CallSelect
                  value={call}
                  onChange={(next) => saveTag("callState", next, call, (v) => setCall(v), setSavingCall)}
                  busy={savingCall}
                  disabled={tagDisabled}
                  disabledHint={tagHint}
                />
                <div className="m-stepper inline-flex items-stretch overflow-hidden whitespace-nowrap rounded-md border border-neutral-700">
                  <span className="inline-flex items-center gap-1 px-2.5 text-xs font-medium tabular-nums text-neutral-200">
                    <svg className="h-3 w-3 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                    {attempts}
                    {attempts > 0 && lead.lastCallAttemptAt && <span className="text-neutral-500">· {ageShort(lead.lastCallAttemptAt)}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => logAttempt(e, -1)}
                    disabled={savingAttempt || attempts === 0}
                    aria-label="One fewer attempt"
                    className="inline-flex min-w-[44px] items-center justify-center border-l border-neutral-700 text-neutral-500 transition-colors hover:bg-surface-200 hover:text-neutral-200 disabled:opacity-40"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={(e) => logAttempt(e, 1)}
                    disabled={savingAttempt}
                    aria-label="Log another attempt"
                    className="inline-flex min-w-[44px] items-center justify-center border-l border-neutral-700 text-neutral-500 transition-colors hover:bg-surface-200 hover:text-neutral-200 disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
              <StateToggle<Qualification>
                value={qual}
                neutral="pending"
                options={[
                  { key: "qualified", label: "Qualified", tone: "good", title: "Made it to a Google Meet" },
                  { key: "unqualified", label: "Unqualified", tone: "danger", title: "Never reached a Google Meet" },
                ]}
                onChange={(next) => saveTag("qualification", next, qual, (v) => setQual(v), setSavingQual)}
                busy={savingQual}
                disabled={tagDisabled}
                disabledHint={tagHint}
              />
              {lead.appointmentAt && (
                <ApptChip at={lead.appointmentAt} status={lead.appointmentStatus} title={lead.appointmentTitle} attendance={lead.apptAttendance ?? lead.latestAttendance} needsConfirm={leadNeedsConfirmation(lead)} needsRebook={lead.needsRebook} />
              )}
            </div>
            <div className={cn("grid gap-x-8 gap-y-5", lead.answers.length > 0 && "md:grid-cols-2")}>
              <div className="space-y-3.5">
                <div className="flex items-center gap-2">
                  <p className="mono-label">Contact</p>
                  {/* Full audit-stage wording here (the row shows only the compact icon). */}
                  {lead.stage && <StageChip stage={lead.stage} />}
                </div>
                <NameEditField
                  value={lead.fullName}
                  revertsTo={lead.nameOriginal}
                  firstName={lead.firstNameOverride}
                  lastName={lead.lastNameOverride}
                  onSave={(first, last) => saveFields({ firstName: first, lastName: last })}
                />
                <div className="grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
                  <InlineEditField
                    label="Email"
                    value={lead.email}
                    revertsTo={lead.emailOriginal}
                    placeholder="Add email"
                    type="email"
                    required
                    onSave={(v) => saveField("email", v)}
                  />
                  <InlineEditField
                    label="Phone"
                    value={lead.phone}
                    revertsTo={lead.phoneOriginal}
                    placeholder="Add phone"
                    type="tel"
                    required
                    onSave={(v) => saveField("phone", v)}
                    actions={(shownPhone) => {
                      // Same suggested template as the row, rebuilt from the number actually on screen
                      // so a just-corrected number can't be shown while WhatsApp opens the old one.
                      const waNow = suggestedKey
                        ? waHref(
                            shownPhone,
                            renderTemplate(templateBody(suggestedKey, waTemplates), {
                              nome: firstName(lead.fullName),
                              dia: lead.appointmentAt ? fmtApptDay(lead.appointmentAt) : null,
                              hora: lead.appointmentAt ? fmtApptTime(lead.appointmentAt) : null,
                            })
                          )
                        : waHref(shownPhone);
                      const telNow = telHref(shownPhone);
                      return (
                      <>
                        {waNow && (
                          <a
                            href={waNow}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={stop}
                            title={suggested ? `WhatsApp — ${suggested.label}. Abre como rascunho, ainda tens de enviar.` : "WhatsApp — chat vazio"}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
                          >
                            <WhatsAppIcon className="h-3 w-3" />
                            WhatsApp
                          </a>
                        )}
                        {/* md:hidden — a tel: link is only useful on the phone he opens this on. */}
                        {telNow && (
                          <a
                            href={telNow}
                            onClick={stop}
                            title={`Call ${shownPhone}`}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-neutral-700 bg-surface-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-300 transition-colors hover:text-neutral-100 md:hidden"
                          >
                            Call
                          </a>
                        )}
                      </>
                      );
                    }}
                  />
                  {/* Mobile parity: the desktop chevron picker lives in the collapsed Phone cell, so a phone
                      gets its own inline picker here — all seven messages, not just the auto-suggested one. */}
                  <div className="mt-2 md:hidden">
                    <button
                      type="button"
                      onClick={(e) => { stop(e); setWaMenuM((s) => !s); }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-surface-200 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:text-neutral-100"
                    >
                      <WhatsAppIcon className="h-3 w-3 text-emerald-400" />
                      Outras mensagens
                      <span className={cn("text-[10px] transition-transform", waMenuM && "rotate-180")}>▾</span>
                    </button>
                    {waMenuM && (
                      <div className="mt-1 flex flex-col rounded-md border border-[#333333] bg-[#242424] p-1" onClick={stop}>
                        {renderWaMenu(() => setWaMenuM(false))}
                      </div>
                    )}
                  </div>
                </div>
                <InlineEditField
                  label="Website"
                  value={lead.website}
                  revertsTo={lead.websiteInferred}
                  href={lead.website ? `https://${lead.website}` : undefined}
                  placeholder="Add website"
                  type="url"
                  onSave={(v) => saveField("website", v)}
                />
                {lead.appointmentAt && (
                  <div className="border-t border-neutral-800/70 pt-3">
                    <p className="text-[11px] uppercase tracking-wider text-neutral-500">Meeting</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-200">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarIcon className="h-3.5 w-3.5 text-neutral-500" />
                        {fmtApptRange(lead.appointmentAt, lead.appointmentEndAt)}
                      </span>
                      {lead.appointmentStatus && (
                        <span className="rounded-md border border-neutral-800 px-1.5 py-0.5 text-[11px] capitalize text-neutral-400">{lead.appointmentStatus}</span>
                      )}
                      {lead.appointmentLink && (
                        <a href={lead.appointmentLink} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                          Join meeting ↗
                        </a>
                      )}
                    </div>
                    {lead.appointmentTitle && <p className="mt-1 text-xs text-neutral-500">{lead.appointmentTitle}</p>}
                  </div>
                )}
                {ghlConfigured && lead.matched && (
                  <div className="border-t border-neutral-800/70 pt-3">
                    <p className="text-[11px] uppercase tracking-wider text-neutral-500">Task</p>
                    {task ? (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="inline-flex items-center gap-1.5 text-neutral-200">
                          <ClockIcon className={cn("h-3.5 w-3.5", TASK_ICON_TONE[dueInfo(task.dueAt).tone])} />
                          {task.title}
                        </span>
                        <span
                          className={cn(
                            "text-xs",
                            dueInfo(task.dueAt).tone === "overdue"
                              ? "text-rose-400"
                              : dueInfo(task.dueAt).tone === "today"
                                ? "text-amber-300"
                                : "text-neutral-500"
                          )}
                        >
                          due {dueInfo(task.dueAt).label}
                        </span>
                        <button
                          type="button"
                          className={PROMPT_BTN}
                          disabled={savingTask}
                          title="Mark completed — stays in GoHighLevel as a done task"
                          onClick={() => completeTask()}
                        >
                          Mark done
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-6 items-center rounded-md border border-rose-500/30 px-2 text-xs font-medium text-rose-300/90 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 disabled:opacity-50"
                          disabled={savingTask}
                          title="Remove entirely — deletes the task from GoHighLevel, no record kept"
                          onClick={() => deleteTask()}
                        >
                          Delete
                        </button>
                      </div>
                    ) : addingTask ? (
                      <AddTaskForm
                        busy={savingTask}
                        onCancel={() => setAddingTask(false)}
                        onSubmit={(title, due) => { setAddingTask(false); void createTask(title, due); }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="mt-1 text-xs text-neutral-400 transition-colors hover:text-neutral-100"
                        onClick={() => setAddingTask(true)}
                      >
                        + Add task
                      </button>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-t border-neutral-800/70 pt-3">
                  {/* Company here too: the table column is hidden on phones, and the expanded panel is
                      the documented home of hidden-column content (review find). */}
                  <InlineEditField
                    label="Company"
                    value={shownCompany}
                    placeholder="—"
                    type="text"
                    dense
                    onSave={(v) => saveCompany(v)}
                  />
                  <InlineEditField
                    label="Additional email"
                    value={lead.additionalEmail}
                    placeholder="—"
                    type="email"
                    dense
                    onSave={(v) => saveField("additionalEmail", v)}
                  />
                  <InlineEditField
                    label="Additional phone"
                    value={lead.additionalPhone}
                    placeholder="—"
                    type="tel"
                    dense
                    onSave={(v) => saveField("additionalPhone", v)}
                  />
                </div>
              </div>
              {lead.answers.length > 0 && (
                <div className="space-y-3.5 md:border-l md:border-neutral-800 md:pl-8">
                  <p className="mono-label">Form answers</p>
                  <dl className="space-y-3">
                    {lead.answers.map((a, i) => (
                      <div key={i} className="text-sm">
                        <dt className="text-sm leading-snug text-neutral-400">{a.label}</dt>
                        <dd className="mt-0.5 text-neutral-100">{prettyAnswer(a.value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
            {ghlConfigured && lead.matched && <MeetingsSection leadId={lead.id} lead={lead} onSaved={onSaved} />}
            {/* Deal value — only leads that actually booked a call carry an opportunity (the GHL
                workflow creates it at booking; sync links it). */}
            {ghlConfigured && lead.matched && (lead.meetingCount > 0 || lead.appointmentAt || lead.ghlOpportunityId) && (
              <OpportunitySection lead={lead} onPatched={(patch) => onSaved(null, patch)} />
            )}
            {ghlConfigured && lead.matched && (
              <NotesSection
                leadId={lead.id}
                initialNotes={lead.notesCache ?? (noteCount === 0 ? [] : null)}
                onCountChange={setNoteCount}
                onSync={(ns) => onSaved(null, { notesCache: ns, notesCount: ns.length })}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
});

const EDIT_INPUT_CLASS =
  "h-7 w-full rounded-md border border-neutral-700 bg-surface-200 px-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20 disabled:opacity-50";

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

/**
 * Name editor with an explicit first/last split — the operator decides which words are the first name
 * and which are the last. Prefills from the saved split when one exists, else first word vs the rest.
 */
function NameEditField({
  value,
  revertsTo,
  firstName,
  lastName,
  onSave,
}: {
  value: string | null; // effective full name (display)
  revertsTo: string | null; // Meta's original name — what a clear reverts to
  firstName: string | null; // saved override split, when the name has been edited before
  lastName: string | null;
  onSave: (first: string, last: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ v: string | null } | null>(null);
  // The just-saved split — the prefill/no-op baseline until the refreshed props land. Without it, an
  // immediate re-edit would prefill from the PRE-save override props and silently undo the last save.
  // "cleared" = the override was just removed: ignore the stale props AND don't treat it as a split.
  const [savedSplit, setSavedSplit] = useState<{ f: string; l: string } | "cleared" | null>(null);
  useEffect(() => setPending(null), [value]);
  useEffect(() => setSavedSplit(null), [firstName, lastName]);
  const shown = pending ? pending.v : value;
  // Baseline split: last save wins, else the stored override EXACTLY as saved (an empty half must
  // prefill empty — falling back to a word-split there would duplicate the other half's words).
  const baseline =
    savedSplit === "cleared" ? null : (savedSplit ?? (firstName || lastName ? { f: firstName ?? "", l: lastName ?? "" } : null));

  function start() {
    if (baseline) {
      setFirst(baseline.f);
      setLast(baseline.l);
    } else {
      const words = (shown ?? "").trim().split(/\s+/).filter(Boolean);
      setFirst(words[0] ?? "");
      setLast(words.slice(1).join(" "));
    }
    setError(null);
    setEditing(true);
  }
  async function save() {
    const f = first.trim();
    const l = last.trim();
    if (baseline && f === baseline.f && l === baseline.l) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const err = await onSave(f, l);
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      // A clear reverts to Meta's original name — show that, not an empty field.
      setPending({ v: [f, l].filter(Boolean).join(" ") || revertsTo });
      setSavedSplit(f || l ? { f, l } : "cleared");
      setEditing(false);
    }
  }
  const keys = (e: { key: string }) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape" && !saving) setEditing(false);
  };

  return (
    <div className="text-sm">
      <p className="text-[11px] uppercase tracking-wider text-neutral-500">Name</p>
      {editing ? (
        <div className="mt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              autoFocus
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              onKeyDown={keys}
              disabled={saving}
              placeholder="First name"
              className={cn(EDIT_INPUT_CLASS, "max-w-[160px]")}
            />
            <input
              value={last}
              onChange={(e) => setLast(e.target.value)}
              onKeyDown={keys}
              disabled={saving}
              placeholder="Last name"
              className={cn(EDIT_INPUT_CLASS, "max-w-[200px]")}
            />
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex h-7 items-center rounded-md border border-neutral-700 bg-neutral-700/30 px-2 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 disabled:opacity-50"
            >
              {saving ? <span className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-neutral-200" /> : "Save"}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving} className="text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50">
              Cancel
            </button>
          </div>
          <p className="mt-1 text-[11px] text-neutral-600">First and last name save to GoHighLevel exactly as split here.</p>
          {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
        </div>
      ) : (
        <button onClick={start} className="group/edit inline-flex max-w-full items-center gap-1.5 text-left" title="Edit name">
          {shown ? <span className="truncate font-medium text-neutral-100">{shown}</span> : <span className="text-rose-400/90">Add name</span>}
          <PencilIcon
            className={cn(
              "h-3 w-3 shrink-0 transition-all",
              shown
                ? "text-neutral-600 opacity-70 group-hover/edit:text-neutral-300 group-hover/edit:opacity-100"
                : "text-rose-400/70 opacity-70 group-hover/edit:opacity-100"
            )}
          />
        </button>
      )}
    </div>
  );
}

/** One label + value that turns into a small input on click. Enter saves, Esc cancels. */
function InlineEditField({
  label,
  value,
  revertsTo,
  href,
  actions,
  placeholder,
  type,
  required = false,
  dense = false,
  onSave,
}: {
  label: string;
  value: string | null;
  /** For fields where clearing REVERTS to an original (primary email/phone) rather than emptying:
   *  the original value, shown after a clear so the revert doesn't read as a deletion. */
  revertsTo?: string | null;
  /** When set, an ↗ link is shown beside the value (e.g. open the website) without blocking editing. */
  href?: string;
  /** Extra links rendered after the value (e.g. WhatsApp / dial on the phone field). Receives the value
   *  actually ON SCREEN — including an optimistic just-saved edit — so a corrected phone number can
   *  never be displayed while the links still point at the old one. Additive: fields that don't pass
   *  it render exactly as before. */
  actions?: (shown: string) => ReactNode;
  placeholder: string;
  type: "email" | "tel" | "url" | "text";
  /** Required contact field: when empty, the add-prompt shows in red so the gap stands out. */
  required?: boolean;
  /** Compact single-line variant for rarely-filled extras (label + value + pencil on one quiet line). */
  dense?: boolean;
  onSave: (value: string) => Promise<string | null>; // resolves to an error message, or null on success
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Show the just-saved value until the server refresh delivers it via props. Wrapped in an object so a
  // pending CLEAR ({v: null}) is distinguishable from "nothing pending" — a bare null would fall back to
  // the stale prop and make every clear look like a failed save.
  const [pending, setPending] = useState<{ v: string | null } | null>(null);
  useEffect(() => setPending(null), [value]);
  const shown = pending ? pending.v : value;

  function start() {
    setDraft(shown ?? "");
    setError(null);
    setEditing(true);
  }
  async function save() {
    const v = draft.trim();
    if (v === (shown ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const err = await onSave(v);
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      setPending({ v: v || revertsTo || null });
      setEditing(false);
    }
  }

  const editor = (
    <div className="mt-0.5">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape" && !saving) setEditing(false);
          }}
          disabled={saving}
          className={cn(EDIT_INPUT_CLASS, "max-w-[240px]", dense && "h-6 max-w-[190px] text-xs")}
        />
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex h-7 items-center rounded-md border border-neutral-700 bg-neutral-700/30 px-2 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 disabled:opacity-50"
        >
          {saving ? <span className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-neutral-200" /> : "Save"}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} className="text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50">
          Cancel
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
    </div>
  );

  // Dense: one quiet line ("LABEL value ✎") for the rarely-filled extras — expands to the full editor on click.
  if (dense) {
    return (
      <div className="min-w-0">
        {editing ? (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-neutral-600">{label}</p>
            {editor}
          </div>
        ) : (
          <button onClick={start} className="group/edit inline-flex max-w-full items-center gap-1.5 text-left" title={`Edit ${label.toLowerCase()}`}>
            <span className="whitespace-nowrap text-[10px] uppercase tracking-wider text-neutral-600">{label}</span>
            {shown ? <span className="truncate text-xs text-neutral-300">{shown}</span> : <span className="text-xs text-neutral-700">{placeholder}</span>}
            <PencilIcon className="h-2.5 w-2.5 shrink-0 text-neutral-600 opacity-70 transition-all group-hover/edit:text-neutral-300 group-hover/edit:opacity-100" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm">
      <p className="text-[11px] uppercase tracking-wider text-neutral-500">{label}</p>
      {editing ? (
        editor
      ) : (
        <span className="flex max-w-full flex-wrap items-center gap-1.5">
          <button onClick={start} className="group/edit inline-flex min-w-0 items-center gap-1.5 text-left" title={`Edit ${label.toLowerCase()}`}>
            {shown ? (
              <span className="truncate text-neutral-200">{shown}</span>
            ) : (
              <span className={required ? "text-rose-400/90" : "text-neutral-600"}>{placeholder}</span>
            )}
            <PencilIcon
              className={cn(
                "h-3 w-3 shrink-0 transition-all",
                !shown && required
                  ? "text-rose-400/70 opacity-70 group-hover/edit:opacity-100"
                  : "text-neutral-600 opacity-70 group-hover/edit:text-neutral-300 group-hover/edit:opacity-100"
              )}
            />
          </button>
          {href && shown && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-xs text-neutral-500 hover:text-neutral-200"
              title={`Open ${shown}`}
            >
              ↗
            </a>
          )}
          {shown && actions?.(shown)}
        </span>
      )}
    </div>
  );
}

function RateBar({ r, qualified, decided }: { r: number | null; qualified: number; decided: number }) {
  if (r === null) return <span className="text-xs text-neutral-600">No decisions yet</span>;
  const pct = Math.round(r * 100);
  // Below MIN_DECIDED the score is a fluke — mute the whole thing so the eye skips it, and spell out
  // WHY next to it ("too few") rather than showing a confident-looking bar built on one lead.
  const weak = decided < MIN_DECIDED;
  const tone = weak ? "bg-neutral-600" : r >= 0.6 ? "bg-emerald-500" : r >= 0.3 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className={cn("flex items-center gap-2", weak && "opacity-45")}>
      <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-neutral-800">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-xs text-neutral-300">{pct}%</span>
      {/* The denominator the score rests on — "3/4 decided" vs "1/1 decided" — so a lucky one-lead
          100% can never look the same as a proven one. */}
      <span className="whitespace-nowrap text-[11px] tabular-nums text-neutral-600" title={`${qualified} qualified of ${decided} decided lead${decided === 1 ? "" : "s"}`}>
        {qualified}/{decided}
        {weak && <span className="ml-1 text-amber-500/70">too few</span>}
      </span>
    </div>
  );
}

function GhlHealth({ ghlConfigured, total, matched }: { ghlConfigured: boolean; total: number; matched: number }) {
  if (!ghlConfigured) {
    return (
      <p className="text-xs text-amber-300/90">
        GoHighLevel isn’t connected — leads show, but qualified/unqualified can’t be read yet.
      </p>
    );
  }
  if (total === 0) return <p className="text-xs text-neutral-500">Connected to GoHighLevel.</p>;
  if (matched === 0) {
    return (
      <p className="text-xs text-amber-300/90">
        0 of {total} leads matched in GoHighLevel yet — status fills in once leads sync into GHL and your team tags them.
      </p>
    );
  }
  return (
    <p className="text-xs text-neutral-500">
      <span className="text-neutral-300">{matched}</span> of {total} leads matched to GoHighLevel.
    </p>
  );
}
