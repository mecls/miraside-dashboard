/**
 * Call/meeting outcomes — the two-layer model.
 *
 * LAYER 1 (attendance): did the call happen? Mirrors GoHighLevel's own appointment vocabulary, so it
 * writes back there and anyone working inside the CRM sees the same truth.
 * LAYER 2 (outcome): what came of it? GoHighLevel has no vocabulary for this, so it lives only here,
 * and only means anything once someone actually showed.
 *
 * Kept separate on purpose: "they turned up" and "we're waiting on a proposal" are different facts, and
 * one flat dropdown would force the operator to erase one to record the other.
 */

export type Attendance = "scheduled" | "showed" | "no_show" | "cancelled";
export type MeetingOutcome = "follow_up_booked" | "proposal_sent" | "won" | "disqualified";
export type DisqualifyReason = "no_budget" | "not_icp" | "bad_timing" | "went_elsewhere" | "other";

export const ATTENDANCE: { value: Attendance; label: string; hint: string }[] = [
  { value: "scheduled", label: "Upcoming", hint: "Booked, hasn't happened yet" },
  { value: "showed", label: "Showed", hint: "They turned up" },
  { value: "no_show", label: "No-show", hint: "They didn't turn up" },
  { value: "cancelled", label: "Cancelled", hint: "Called off before it happened" },
];

export const OUTCOMES: { value: MeetingOutcome; label: string; hint: string }[] = [
  { value: "follow_up_booked", label: "Follow-up booked", hint: "Went well — another call is scheduled" },
  { value: "proposal_sent", label: "Proposal sent", hint: "Waiting on their decision" },
  { value: "won", label: "Won", hint: "Became a client" },
  { value: "disqualified", label: "Disqualified", hint: "Not a fit" },
];

export const DISQUALIFY_REASONS: { value: DisqualifyReason; label: string }[] = [
  { value: "no_budget", label: "No budget" },
  { value: "not_icp", label: "Not our ideal client" },
  { value: "bad_timing", label: "Bad timing" },
  { value: "went_elsewhere", label: "Went elsewhere" },
  { value: "other", label: "Other" },
];

/**
 * Which outcomes can follow a given attendance. A call they missed can still resolve — you reach them
 * and rebook, or you write them off — and it MUST be able to, because recording an outcome is the only
 * thing that clears the "Missed — rebook" queue. Offering "Won" on a no-show would be nonsense, so the
 * set is narrowed rather than hidden.
 *
 * `scheduled` returns none: nothing can have come of a call that hasn't happened.
 */
export function outcomesFor(attendance: Attendance): typeof OUTCOMES {
  if (attendance === "showed") return OUTCOMES;
  if (attendance === "no_show" || attendance === "cancelled") {
    return OUTCOMES.filter((o) => o.value === "follow_up_booked" || o.value === "disqualified").map((o) =>
      o.value === "follow_up_booked"
        ? { ...o, label: "Rebooked", hint: "Reached them again — another call is scheduled" }
        : { ...o, hint: "Gave up on them, or they're not a fit" }
    );
  }
  return [];
}

/** True when this outcome is still meaningful for that attendance — used to clear a contradictory one
 *  (e.g. "Won" left behind after correcting a call from Showed to No-show). */
export function outcomeAppliesTo(attendance: Attendance, outcome: MeetingOutcome | null): boolean {
  if (!outcome) return true;
  return outcomesFor(attendance).some((o) => o.value === outcome);
}

export const ATTENDANCE_VALUES = new Set<string>(ATTENDANCE.map((a) => a.value));
export const OUTCOME_VALUES = new Set<string>(OUTCOMES.map((o) => o.value));
export const DISQUALIFY_VALUES = new Set<string>(DISQUALIFY_REASONS.map((d) => d.value));

/** Colour per attendance — sky for a live booking (matching the Meeting chip), rose for a miss. */
export const ATTENDANCE_STYLE: Record<Attendance, string> = {
  scheduled: "border-sky-500/40 bg-sky-500/15 text-sky-300",
  showed: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  no_show: "border-rose-500/40 bg-rose-500/15 text-rose-300",
  cancelled: "border-neutral-700 bg-surface-200 text-neutral-400",
};
export const ATTENDANCE_DOT: Record<Attendance, string> = {
  scheduled: "bg-sky-400",
  showed: "bg-emerald-400",
  no_show: "bg-rose-400",
  cancelled: "bg-neutral-600",
};

export interface LeadMeeting {
  id: string;
  ghlAppointmentId: string | null;
  /** The GHL booking calendar this appointment lives on — needed to build its reschedule link. */
  calendarId: string | null;
  startsAt: string;
  endsAt: string | null;
  title: string | null;
  link: string | null;
  attendance: Attendance;
  outcome: MeetingOutcome | null;
  disqualifyReason: DisqualifyReason | null;
  notes: string | null;
  /** Day-before confirmation: when the operator confirmed the upcoming call with the lead. */
  confirmedAt: string | null;
}

/**
 * GoHighLevel's own reschedule page for one appointment (white-label domain). Opens the booking
 * calendar with the existing slot loaded — pick a new time, confirm, done; the calendar webhook/sync
 * mirrors the move back here. Format verified against a real GHL invite (2026-07-22):
 *   reschedule → /widget/booking/{calendarId}?event_id={appointmentId}
 */
const GHL_WIDGET_BASE = "https://api.miraside.co";
export function rescheduleUrl(m: { ghlAppointmentId: string | null; calendarId: string | null }): string | null {
  if (!m.ghlAppointmentId || !m.calendarId) return null;
  return `${GHL_WIDGET_BASE}/widget/booking/${encodeURIComponent(m.calendarId)}?event_id=${encodeURIComponent(m.ghlAppointmentId)}`;
}

/** The "Follow-up Call" booking calendar in GoHighLevel (30-min; listed via the calendars API). */
export const FOLLOW_UP_CALENDAR_ID = "423UMdjxJoj43dS930AQ";

/**
 * The location's bookable calendars, read live from `GET /calendars/?locationId=…` on 2026-08-18.
 *
 * Hardcoded rather than fetched: the picker must render instantly with the row, the set changes maybe
 * once a year, and a failed fetch would leave the operator with an empty menu mid-call. `id` is the
 * contract — the widget URL and every `lead_meetings.calendar_id` key off it.
 *
 * `common` marks the three calendars that carry real traffic (live booking counts at the time of
 * writing: Sessão de Estratégia 22, Follow-up 9, AI Audit 1, the other three zero). The picker shows
 * those first and files the rest under a divider, so the list reads as "what you actually book".
 *
 * NOTE: nothing here is named "Discovery" — in this location the discovery call IS
 * "Sessão de Estratégia de IA". The pipeline stage it feeds is "Booked Call - Discovery".
 */
export interface BookingCalendar {
  id: string;
  /** Exactly as it reads in GoHighLevel — renaming it here would make the two systems disagree. */
  name: string;
  /** What this call IS, for an operator scanning the menu mid-call. */
  hint: string;
  minutes: number;
  common: boolean;
}
export const BOOKING_CALENDARS: BookingCalendar[] = [
  { id: "fXnSMAnSS2QsGMfmHIkN", name: "Sessão de Estratégia de IA", hint: "Discovery — the PT first call", minutes: 30, common: true },
  { id: FOLLOW_UP_CALENDAR_ID, name: "Follow-up Call", hint: "The second call, after a discovery", minutes: 30, common: true },
  { id: "47V7G6Pg8rcagBLwdi3W", name: "AI Audit Call", hint: "Walk them through their audit", minutes: 30, common: true },
  { id: "AxjqJSF3L6GZkt9s7HRU", name: "Onboarding Call", hint: "Kick-off, after they sign", minutes: 30, common: false },
  { id: "mZJkEAcaC4HuCEo0Mfw9", name: "Intro Call", hint: "Short intro", minutes: 30, common: false },
  { id: "wBhfgwiGQk1MtvplzNpU", name: "AI Strategy Call", hint: "Strategy, in English", minutes: 30, common: false },
];

/** The discovery calendar — the default for a lead that has never sat on a call. */
export const DISCOVERY_CALENDAR_ID = "fXnSMAnSS2QsGMfmHIkN";
/** Kick-off, once they're a client. */
export const ONBOARDING_CALENDAR_ID = "AxjqJSF3L6GZkt9s7HRU";

export function bookingCalendar(id: string): BookingCalendar | null {
  return BOOKING_CALENDARS.find((c) => c.id === id) ?? null;
}

/**
 * Which call this lead most likely needs next — the picker's pre-selection, never a lock: every
 * calendar stays one click away.
 *
 * Won → onboarding (they're a client, the next call is kick-off).
 * Sat on a call → follow-up (the existing "Book follow-up" button encodes exactly this rule).
 * Anything else, including a lead whose only booking was missed → discovery: a no-show never had the
 * first call, so the call they still owe is the first one.
 */
export function suggestedCalendarId(lead: {
  latestAttendance?: Attendance | null;
  latestOutcome?: MeetingOutcome | null;
  opportunityStatus?: string | null;
}): string {
  if (lead.opportunityStatus === "won" || lead.latestOutcome === "won") return ONBOARDING_CALENDAR_ID;
  if (lead.latestAttendance === "showed") return FOLLOW_UP_CALENDAR_ID;
  return DISCOVERY_CALENDAR_ID;
}

/** The contact details the booking form can take off our hands. */
export interface BookingContact {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

/**
 * A GoHighLevel booking page with the lead's details pre-filled, so booking is pick-a-slot and done.
 *
 * Param names verified LIVE against the real discovery widget (2026-08-18, stepping the form open in a
 * browser): `first_name`, `last_name`, `email`, `phone` and `website` all land in their fields. Phone
 * MUST be E.164 with the `+` — the widget's intl-tel-input parses `+351912345678` into "912 345 678"
 * with the country flag set, and drops the number entirely if the prefix is missing.
 *
 * Params are omitted when falsy: an empty `email=` would render as a filled-in blank the operator has
 * to clear. Forms that lack a given field simply ignore its param.
 */
export function bookingUrl(calendarId: string, c: BookingContact): string {
  const p = new URLSearchParams();
  if (c.firstName) p.set("first_name", c.firstName);
  if (c.lastName) p.set("last_name", c.lastName);
  if (c.email) p.set("email", c.email);
  if (c.phone) p.set("phone", c.phone);
  if (c.website) p.set("website", c.website);
  const q = p.toString();
  return `${GHL_WIDGET_BASE}/widget/booking/${encodeURIComponent(calendarId)}${q ? `?${q}` : ""}`;
}

/**
 * The follow-up booking page. Unchanged behaviour — kept as its own export because the post-call
 * "Book follow-up ↗" button is built on it and must not shift.
 */
export function followUpBookingUrl(c: BookingContact): string {
  return bookingUrl(FOLLOW_UP_CALENDAR_ID, c);
}

/** GoHighLevel's appointmentStatus → our attendance. Unknown/`new` reads as still-scheduled. */
export function attendanceFromGhl(status: string | null | undefined): Attendance {
  switch (String(status ?? "").toLowerCase()) {
    case "showed":
      return "showed";
    case "noshow":
    case "no-show":
      return "no_show";
    case "cancelled":
    case "canceled":
    case "invalid":
      return "cancelled";
    default:
      return "scheduled"; // "confirmed", "new", anything unrecognised
  }
}

/**
 * A meeting still owed work: they missed it (or called it off) and nobody has recorded what happened
 * since. This is the no-show recovery queue's predicate — the most valuable leads in the pipeline,
 * which previously vanished because a booking (any booking) took them off every call list.
 */
export function needsRebooking(m: { attendance: Attendance; outcome: MeetingOutcome | null }): boolean {
  return (m.attendance === "no_show" || m.attendance === "cancelled") && !m.outcome;
}

/**
 * Does this LEAD still owe a rebook? Judged on its most recent meeting only.
 *
 * Deliberately not "any missed meeting ever": once they no-show and you rebook them, a newer booking
 * exists and the lead is handled — but the old missed row never changes, so an "any" test would pin
 * them at the top of the queue permanently, which is the exact mis-ranked call list this replaced.
 */
export function leadNeedsRebooking(meetings: { attendance: Attendance; outcome: MeetingOutcome | null; startsAt: string }[]): boolean {
  if (!meetings.length) return false;
  const latest = meetings.reduce((a, b) => (new Date(b.startsAt).getTime() > new Date(a.startsAt).getTime() ? b : a));
  return needsRebooking(latest);
}

/** The auto-created "missed call → go rebook them" GHL task. The title must NOT contain "call again"
 *  or "follow up": the sync's reach-out auto-complete matches those and judges manual meetings by time
 *  alone, so it was completing this task while the just-missed call still looked "live". The regex is
 *  an exact-prefix match so operator-written reminders ("Remarcar proposta…") are never touched. */
export const REBOOK_TASK_TITLE = "Call to rebook the meeting";
export const REBOOK_TASK_RE = /^call to rebook\b/i;

/** A booking that has come and gone but nobody has said whether the person turned up.
 *  45-min grace after the start: the call is presumed IN PROGRESS for its first ~45 minutes (matches the
 *  WhatsApp late-arrival window), so the "did they show?" nag can't fire while the operator is literally
 *  on the call — a just-started 11:00 call was landing in "Awaiting outcome" at 11:01. */
export const MEETING_IN_PROGRESS_MS = 45 * 60 * 1000;
export function awaitingOutcome(m: { attendance: Attendance; startsAt: string }, now = Date.now()): boolean {
  return m.attendance === "scheduled" && new Date(m.startsAt).getTime() + MEETING_IN_PROGRESS_MS < now;
}
