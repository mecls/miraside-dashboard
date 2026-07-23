// Pure helpers: turn builder questions into valid Meta leadgen question objects. Server + client safe.

const STANDARD_TYPES = new Set(["FULL_NAME", "EMAIL", "PHONE", "COMPANY_NAME", "JOB_TITLE"]);

export function slug(s: string, fallback: string): string {
  const out = String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return out || fallback;
}

/**
 * Builder questions → Meta leadgen question objects. Supports:
 *  - CUSTOM with options  → multiple choice
 *  - CUSTOM without options → short answer (free text)
 *  - DATE_TIME            → appointment request (lead picks a preferred date & time)
 *  - standard contact types (FULL_NAME / EMAIL / PHONE / …)
 */
// Ensure keys are unique within their scope: two same-slug labels ("Budget?" / "Budget!") would otherwise
// both key to "budget" and collide as Meta field keys (N-leadform). Appends _2, _3, … on collision.
function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return key;
}

export function normalizeQuestions(raw: any): any[] {
  const fallback = [{ type: "FULL_NAME" }, { type: "EMAIL" }, { type: "PHONE" }];
  if (!Array.isArray(raw) || !raw.length) return fallback;
  const qs: any[] = [];
  const usedQKeys = new Set<string>();
  raw.forEach((q: any, i: number) => {
    const type = String(q?.type || "").toUpperCase();
    if (type === "CUSTOM") {
      const label = String(q?.label || "").trim();
      if (!label) return;
      const cq: any = { type: "CUSTOM", key: uniqueKey(slug(label, `q_${i}`), usedQKeys), label };
      const usedOptKeys = new Set<string>();
      const options = Array.isArray(q?.options)
        ? q.options
            .map((o: any, j: number) => {
              const value = String(typeof o === "string" ? o : o?.value || "").trim();
              return value ? { key: uniqueKey(slug(value, `opt_${j}`), usedOptKeys), value } : null;
            })
            .filter(Boolean)
        : [];
      if (options.length) cq.options = options; // omit -> free-text custom question
      qs.push(cq);
    } else if (type === "DATE_TIME") {
      // Appointment request — a date/time picker. A custom label is optional.
      const label = String(q?.label || "").trim();
      qs.push(label ? { type: "DATE_TIME", label } : { type: "DATE_TIME" });
    } else if (STANDARD_TYPES.has(type)) {
      qs.push({ type });
    }
  });
  return qs.length ? qs : fallback;
}

/** Raw greeting (intro) saved on a template. */
export type GreetingInput = { headline?: string; style?: "paragraph" | "list"; paragraph?: string; bullets?: string[]; buttonText?: string } | null | undefined;

/**
 * Greeting → Meta `context_card` object, or null when there's nothing to show.
 * Paragraph style → one content string; list style → up to 5 bullet strings.
 */
export function normalizeGreeting(raw: GreetingInput): { title: string; style: string; content: string[]; button_text?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const headline = String(raw.headline || "").trim();
  const isList = raw.style === "list";
  const bullets = Array.isArray(raw.bullets) ? raw.bullets.map((b) => String(b || "").trim()).filter(Boolean).slice(0, 5) : [];
  const paragraph = String(raw.paragraph || "").trim();
  const content = isList ? bullets : paragraph ? [paragraph] : [];
  if (!headline && !content.length) return null;
  const card: { title: string; style: string; content: string[]; button_text?: string } = {
    title: headline || "Bem-vindo",
    style: isList ? "LIST_STYLE" : "PARAGRAPH_STYLE",
    content: content.length ? content : [" "],
  };
  const btn = String(raw.buttonText || "").trim();
  if (btn) card.button_text = btn;
  return card;
}
