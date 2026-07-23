/**
 * Fingerprint a question/field label so matching ignores case, accents, punctuation and spacing.
 *
 * GHL dedupes custom fields on a slugified `fieldKey`, so "Quantos colaboradores tem a tua empresa?" and
 * "…empresa" (no "?") are the SAME field to it. Matching on the display name couldn't see that: it missed,
 * tried to create a duplicate, GHL 400'd, and the whole lead push died. Fingerprinting both sides makes the
 * match punctuation/accent/case-proof.
 *
 * Pure + dependency-free on purpose: the launcher's form builder imports this in the browser to preview a
 * question's GHL mapping, and the lead pipeline imports it on the server. Both MUST agree exactly.
 */
export function fieldFingerprint(s: string): string {
  return String(s ?? "")
    .replace(/^contact\./i, "") // GHL fieldKeys are prefixed with the model
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // drop accents: negócio → negocio
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // underscores + punctuation → space
    .trim();
}
