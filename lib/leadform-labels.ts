import { getLeadFormDefinition } from "./meta-ads";
import type { LeadAnswer } from "./leads";

/**
 * Real question text AND real option labels for an instant form, keyed by Meta's slugified keys.
 *
 * A lead's `field_data` only carries slugs — accents and punctuation are destroyed on BOTH sides:
 *   question: "Qual é o desafio #1 para escalar o teu negócio?" → "qual_e_o_desafio_1_para_escalar_o_teu_nego_cio"
 *   answer:   "Não" → "na_o", "2–9" → "2_9", "50+" → "50", "Gerir a equipa e as operações" → "gerir_a_equipa_e_as_operac_o_es"
 * Un-slugging ("_" → " ") gives mangled text ("Na o", "2 9", "operac o es"). The form definition is the
 * ONLY place the true text exists, so fetch it once and map key → label and optionKey → optionValue.
 *
 * Cached per process, per form (forms are immutable on Meta, so this can never go stale).
 */
interface FormMeta {
  labels: Map<string, string>; // question key → real question text
  options: Map<string, Map<string, string>>; // question key → (option key → real option label)
}
const cache = new Map<string, FormMeta>();

async function formQuestionMeta(formId: string): Promise<FormMeta> {
  const hit = cache.get(formId);
  if (hit) return hit;

  const meta: FormMeta = { labels: new Map(), options: new Map() };
  try {
    const f = await getLeadFormDefinition(formId);
    for (const q of f?.questions ?? []) {
      if (!q?.key) continue;
      if (q.label) meta.labels.set(String(q.key), String(q.label));
      if (Array.isArray(q.options) && q.options.length) {
        const opts = new Map<string, string>();
        for (const o of q.options) {
          if (o?.key != null && o?.value) opts.set(String(o.key), String(o.value));
        }
        if (opts.size) meta.options.set(String(q.key), opts);
      }
    }
  } catch {
    // Best-effort: fall back to slug-derived text. Degraded output, never a dropped lead.
  }
  cache.set(formId, meta); // cache misses too — a form we can't read shouldn't be retried per lead
  return meta;
}

export async function formQuestionLabels(formId: string): Promise<Map<string, string>> {
  return (await formQuestionMeta(formId)).labels;
}

/** Last-resort prettifier for slugs we can't map (free text is passed through untouched upstream):
 *  numeric ranges get their separator back ("2_9" → "2-9"); other underscores become spaces. */
export function prettySlug(v: string): string {
  if (!v || !v.includes("_")) return v;
  const range = v.match(/^(\d+)_(\d+)$/);
  if (range) return `${range[1]}-${range[2]}`;
  const s = v.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Replace a lead's slugged question labels and multiple-choice answer values with the form's REAL
 * text ("na_o" → "Não", "2_9" → "2–9", "gerir_a_equipa_e_as_operac_o_es" → "Gerir a equipa e as
 * operações"). Free-text answers have no option entry and pass through as typed. Returns new
 * answer objects; on any Meta failure the originals come back with only the slug prettifier applied.
 */
export async function resolveMetaAnswers(answers: LeadAnswer[], formId: string | null): Promise<LeadAnswer[]> {
  if (!answers.length) return answers;
  const meta = formId ? await formQuestionMeta(formId) : { labels: new Map<string, string>(), options: new Map<string, Map<string, string>>() };
  return answers.map((a) => ({
    ...a,
    label: meta.labels.get(a.key) ?? a.label,
    value: meta.options.get(a.key)?.get(a.value) ?? prettySlug(a.value),
  }));
}
