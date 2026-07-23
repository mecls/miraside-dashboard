/**
 * Turning a stored lead phone number into something you can act on: a WhatsApp chat or a phone dial.
 *
 * Numbers reach us in mixed shapes — Meta hands back "+351912345678", an operator correction may be
 * typed as "912 345 678" or "00351912345678". Both link forms need different normalisations, and BOTH
 * return null rather than a broken link when the number can't be trusted: a wa.me link built from a
 * malformed number opens a chat with the wrong person, which is worse than no link at all.
 */

/** Portugal — the only market this account runs in, so a bare 9-digit local number is Portuguese. */
const DEFAULT_CC = "351";

/** `tel:` for dialling. Keeps a leading + so the phone dials the international form correctly. */
export function telHref(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  const cleaned = s.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, ""); // one leading + at most
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `tel:${cleaned}`;
}

/**
 * `https://wa.me/<international digits>` — works on desktop (opens WhatsApp Web or the desktop app)
 * and on a phone (opens the app). The number must be full international WITHOUT + or leading zeros;
 * wa.me silently fails on anything else.
 */
export function waHref(raw: string | null | undefined, text?: string | null): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2); // 00351… → 351…
  if (digits.length === 9) digits = DEFAULT_CC + digits; // bare local number
  // Anything outside plausible E.164 length is a typo or a truncated import — no link.
  if (digits.length < 11 || digits.length > 15) return null;
  const q = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${q}`;
}

/** First name only — what a WhatsApp opener should use. Falls back to "" for a nameless lead. */
export function firstName(fullName: string | null | undefined): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * The pre-filled WhatsApp opener, in Portuguese (the market these ads run in). Sent as a draft the
 * operator can edit before hitting send — never auto-sent.
 */
export function waOpener(fullName: string | null | undefined): string {
  const n = firstName(fullName);
  const greeting = n ? `Olá ${n}` : "Olá";
  return `${greeting}, é o Miguel da Miraside. Recebi o teu pedido — quando é que tens 5 minutos para falarmos?`;
}
