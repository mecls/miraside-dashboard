/**
 * WhatsApp quick-reply templates.
 *
 * Each template maps to a state the dashboard already knows, so the WhatsApp button can pre-select the
 * right one and the operator doesn't have to think at the moment of acting. All seven live in Settings
 * (keys below), so Miguel can reword them without a deploy; these are the defaults.
 *
 * Register: informal "tu" — deliberately matching the lead form the person just filled in ("Qual é o
 * TEU cargo", "o problema que QUERES resolver"). Switching to "você" here would change voice between
 * the form and the first message, minutes apart.
 *
 * Placeholders: {nome} first name, {dia} meeting date, {hora} meeting time. Any placeholder with no
 * value is dropped along with awkward leftovers rather than rendered literally.
 */
import type { CallState } from "./leads";
import type { Attendance } from "./meetings";

export type TemplateKey =
  | "wa_tpl_first_contact"
  | "wa_tpl_no_answer"
  | "wa_tpl_last_attempt"
  | "wa_tpl_confirm"
  | "wa_tpl_waiting"
  | "wa_tpl_no_show"
  | "wa_tpl_cancelled";

export interface WaTemplate {
  key: TemplateKey;
  /** Short label for the picker menu. */
  label: string;
  /** When this one is the automatic choice — shown as the menu's secondary line. */
  when: string;
  body: string;
  /** Needs a booked meeting to say anything sensible; the picker greys it out without one. */
  needsMeeting?: boolean;
}

/** Attempts at which the gentler "no answer" message gives way to the last-attempt one. */
export const LAST_ATTEMPT_THRESHOLD = 3;

/** How long after the start time a meeting still counts as "happening now" for the late-arrival nudge. */
const MEETING_WINDOW_MS = 45 * 60 * 1000;
function isDuringMeeting(startIso: string, now = Date.now()): boolean {
  const t = new Date(startIso).getTime();
  if (isNaN(t)) return false;
  return t <= now && now < t + MEETING_WINDOW_MS;
}

export const WA_TEMPLATES: WaTemplate[] = [
  {
    key: "wa_tpl_first_contact",
    label: "Primeiro contacto",
    when: "Ainda não ligaste",
    body: "Olá {nome}, vi agora que pediste mais informações sobre o nosso anúncio.\nQual é a melhor altura para te ligar?",
  },
  {
    key: "wa_tpl_no_answer",
    label: "Não atendeu",
    when: "Ligaste e não atendeu",
    body: "{nome}, liguei-te agora sem sucesso.\nQual o melhor horário para falarmos?",
  },
  {
    key: "wa_tpl_last_attempt",
    label: "Última tentativa",
    when: `${LAST_ATTEMPT_THRESHOLD}+ tentativas sem resposta`,
    body: "{nome}, ainda não conseguimos falar.\nMantenho o teu pedido em aberto?",
  },
  {
    key: "wa_tpl_confirm",
    label: "Confirmar reunião",
    when: "Reunião marcada e ainda por acontecer",
    // Assume, don't ask: "confirmas?" / "mantém-se?" concede that it might not happen.
    body: "{nome}, falamos {dia} às {hora}.\nAté lá.",
    needsMeeting: true,
  },
  {
    key: "wa_tpl_waiting",
    label: "Atraso na reunião",
    when: "Hora da reunião passou, ainda não entrou",
    // Sent while we still expect them, right after the call goes unanswered. "Já estamos na sala" says
    // the thing is happening without them; never "à tua espera", which puts us in the waiting position.
    body: "{nome}, já estamos na sala.\nConsegues encontrar o link para entrar?",
    needsMeeting: true,
  },
  {
    key: "wa_tpl_no_show",
    label: "Não compareceu",
    when: "Faltou à reunião",
    // Altitude without a reprimand: state the fact, offer one window, don't chase.
    // No {dia}/{hora} and it speaks to a PAST meeting, so it reads fine without a live booking — the
    // picker must not grey it out (pickTemplate suggests it purely from latestAttendance === "no_show").
    body: "{nome}, hoje não chegámos a falar.\nQueres remarcar para esta semana?",
  },
  {
    key: "wa_tpl_cancelled",
    label: "Remarcar",
    when: "Cancelou a reunião",
    body: "{nome}, sem problema.\nIndica-me dois horários e remarco.",
  },
];

export const WA_TEMPLATE_KEYS = WA_TEMPLATES.map((t) => t.key);
const BY_KEY = new Map(WA_TEMPLATES.map((t) => [t.key, t]));

/**
 * Which template fits this lead right now. Ordered most-specific first: what happened to the MEETING
 * outranks what happened on the phone, because a missed or cancelled call is the more recent and more
 * important fact about the lead.
 */
export function pickTemplate(lead: {
  callState: CallState;
  callAttempts: number;
  latestAttendance?: Attendance | null;
  appointmentAt?: string | null;
}): TemplateKey | null {
  // The meeting is happening RIGHT NOW and nobody has ruled on it yet: the operator has just called and
  // got no answer, and is still expecting them. This is the one message whose moment is a time window
  // rather than a state, so it is checked first.
  if (
    lead.appointmentAt &&
    (!lead.latestAttendance || lead.latestAttendance === "scheduled") &&
    isDuringMeeting(lead.appointmentAt)
  ) {
    return "wa_tpl_waiting";
  }
  if (lead.latestAttendance === "no_show") return "wa_tpl_no_show";
  if (lead.latestAttendance === "cancelled") return "wa_tpl_cancelled";
  // An upcoming booking → the confirmation, which is the one that PREVENTS a no-show rather than
  // recording it. Only while the meeting is still ahead of us.
  if (lead.appointmentAt && new Date(lead.appointmentAt).getTime() > Date.now()) return "wa_tpl_confirm";
  if (lead.callState === "no_answer") {
    return lead.callAttempts >= LAST_ATTEMPT_THRESHOLD ? "wa_tpl_last_attempt" : "wa_tpl_no_answer";
  }
  // No template fits, so send NO text rather than the wrong text. Two cases:
  //  - we have already spoken to them (by phone, or in a meeting they attended);
  //  - their meeting has come and gone and nobody has yet said whether they showed. Falling through to
  //    the cold opener here would greet someone who booked a meeting with "vi agora que pediste mais
  //    informações sobre o nosso anúncio".
  // The picker is still one click away.
  if (lead.latestAttendance === "showed" || lead.callState === "contacted") return null;
  if (lead.appointmentAt && new Date(lead.appointmentAt).getTime() < Date.now()) return null;
  return "wa_tpl_first_contact";
}

/** First name only — what an opener should use. "" for a nameless lead. */
export function firstName(fullName: string | null | undefined): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Fill a template. A placeholder with no value is removed rather than left as "{hora}" — and the
 * leftover joining words around it go too, so a missing meeting time can't produce
 * "a nossa call de  às ." in a message about to be sent to a real person.
 */
export function renderTemplate(
  body: string,
  vars: { nome?: string | null; dia?: string | null; hora?: string | null }
): string {
  let out = body;
  const nome = (vars.nome ?? "").trim();
  if (nome) {
    out = out.replace(/\{nome\}/g, nome);
  } else {
    // No name. A token that STARTS the message takes its trailing comma with it ("{nome}, liguei…" →
    // "liguei…", not ", liguei…"); a token mid-sentence drops the space before it ("Olá {nome}," →
    // "Olá,"). The now-lowercase opener is re-capitalised at the end.
    out = out.replace(/^\s*\{nome\}[,:;]?\s*/gm, "").replace(/\s*\{nome\}/g, "");
  }
  for (const [k, raw] of [["dia", vars.dia], ["hora", vars.hora]] as const) {
    const v = (raw ?? "").trim();
    if (v) {
      out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
      continue;
    }
    // No value: drop the placeholder AND the preposition that introduces it, or the message reads
    // "a nossa call às." / "na call das mas não…". Deliberately NOT using \b — it is ASCII-only, so
    // it never matches before "às" and left the preposition behind (caught by test, 2026-07-21).
    out = out.replace(new RegExp(`\\s*(?:de|da|das|do|dos|à|às|as|ao|aos|em|no|na|para)?\\s*\\{${k}\\}`, "giu"), "");
  }
  // Tidy anything the removals left behind.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.?!])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim()
    // A dropped leading name can leave the message starting mid-word ("liguei-te…"); restore the capital.
    .replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
}

/** The template's text: the tenant's Settings override when present, else the built-in default. */
export function templateBody(key: TemplateKey, overrides: Record<string, unknown> | null | undefined): string {
  const v = overrides?.[key];
  const s = typeof v === "string" ? v.trim() : "";
  return s || BY_KEY.get(key)?.body || "";
}
