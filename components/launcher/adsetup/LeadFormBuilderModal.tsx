"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { ModalCard } from "./ModalCard";
import { LeadFormPreview } from "./LeadFormPreview";
import { GhlFieldMap, type GhlField, type GhlPin } from "./GhlFieldMap";
import { fieldFingerprint } from "@/lib/fingerprint";
import { PlusIcon, TrashIcon, XIcon } from "../icons";

type QKind = "mc" | "short" | "appt"; // multiple choice / short answer / appointment request
type BQ = { kind: QKind; label: string; options: string[] };

const KIND_META: Record<QKind, { name: string; hint: string }> = {
  mc: { name: "Multiple choice", hint: "Leads pick one of your answers." },
  short: { name: "Short answer", hint: "Leads type a free-text answer." },
  appt: { name: "Appointment request", hint: "Leads pick a preferred date & time." },
};

const STD = [
  { key: "FULL_NAME", label: "Full name" },
  { key: "PHONE", label: "Phone" },
  { key: "EMAIL", label: "Email" },
];

// Lead-facing: an appointment question is only kept if it has a label (see submit()), so this prefill
// always ships to Meta as questions[].label. Portuguese, because Meta stores question labels verbatim.
const APPT_LABEL = "Data e hora preferidas";

// Sensible starting thank-you so a new form works out of the box; fully editable per form.
// Lead-facing, so Portuguese: Meta stores these verbatim and the form's locale never translates them.
const DEFAULT_TY = { headline: "Obrigado — recebemos os teus dados!", message: "Entraremos em contacto brevemente.", website: "", button: "" };

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="mono-label block">{children}</label>
);
const inputClass =
  "w-full rounded-md border border-neutral-700 bg-surface-200 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20";

/** Reverse a stored (Meta-shape) questions array back into the builder's question + contact-field state. */
function questionsToBuilder(questions: any[]): { qs: BQ[]; std: Record<string, boolean> } {
  const qs: BQ[] = [];
  const std: Record<string, boolean> = { FULL_NAME: false, PHONE: false, EMAIL: false };
  for (const q of Array.isArray(questions) ? questions : []) {
    const type = String(q?.type ?? "").toUpperCase();
    if (type === "CUSTOM") {
      const opts = Array.isArray(q?.options) ? q.options.map((o: any) => String(typeof o === "string" ? o : o?.value ?? "")).filter(Boolean) : [];
      qs.push(opts.length ? { kind: "mc", label: String(q?.label ?? ""), options: opts.length >= 2 ? opts : [...opts, ""] } : { kind: "short", label: String(q?.label ?? ""), options: [] });
    } else if (type === "DATE_TIME") {
      qs.push({ kind: "appt", label: String(q?.label ?? APPT_LABEL), options: [] });
    } else if (type in std) {
      std[type] = true;
    }
  }
  return { qs, std };
}

/**
 * Build or edit a lead form: greeting + qualifying questions + contact fields + the after-submit
 * (thank-you) screen. Privacy is auto-added. The Meta instant form is minted on launch — except
 * "Use once", which mints it immediately and isn't saved to the library.
 */
export function LeadFormBuilderModal({
  defaultName = "",
  editId = null,
  pageName = "",
  onDone,
  onDeleted,
  onClose,
}: {
  defaultName?: string;
  editId?: string | null;
  pageName?: string; // the Facebook Page name, shown in the live preview header
  onDone: (form: { id: string; name: string }) => void;
  onDeleted?: (id: string) => void; // form removed from the library — drop it from the picker + any selection
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  // Greeting (intro shown before the questions).
  const [gHeadline, setGHeadline] = useState("");
  const [gStyle, setGStyle] = useState<"paragraph" | "list">("paragraph");
  const [gParagraph, setGParagraph] = useState("");
  const [gBullets, setGBullets] = useState<string[]>([""]);
  // Questions + contact fields.
  const [qs, setQs] = useState<BQ[]>([]);
  const [std, setStd] = useState<Record<string, boolean>>({ FULL_NAME: true, PHONE: true, EMAIL: false });
  // After-submit (thank-you) screen.
  const [tyHeadline, setTyHeadline] = useState(DEFAULT_TY.headline);
  const [tyMessage, setTyMessage] = useState(DEFAULT_TY.message);
  const [tyWebsite, setTyWebsite] = useState(DEFAULT_TY.website);
  const [tyButton, setTyButton] = useState(DEFAULT_TY.button);
  // ROI Audit form switch — only this form's leads forward to the audit intake (default off).
  const [isAudit, setIsAudit] = useState(false);

  const [busy, setBusy] = useState<null | "new" | "update" | "once" | "delete">(null);
  const [loading, setLoading] = useState(!!editId);
  const [previewing, setPreviewing] = useState(false);

  // Where each question's answers will land in GHL, resolved live so a duplicate custom field is caught
  // here — before launching — instead of in the webhook, where it silently dropped every lead.
  const [ghlFields, setGhlFields] = useState<GhlField[]>([]);
  const [ghlPins, setGhlPins] = useState<GhlPin[]>([]);
  const [ghlLoading, setGhlLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ghl/fields");
        const j = await res.json().catch(() => ({}));
        if (alive && j?.ok) { setGhlFields(j.fields ?? []); setGhlPins(j.pins ?? []); }
      } catch {
        // GHL unreachable → just don't show the mapping; the pipeline still self-heals.
      }
      if (alive) setGhlLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  /** Pin a question to a specific GHL field (or back to auto). Saved immediately — it's a standing decision. */
  async function pinField(label: string, ghlFieldId: string | null) {
    const prev = ghlPins;
    try {
      const res = await fetch("/api/ghl/fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, ghlFieldId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { toast(j?.error || "Couldn't save that mapping", "error"); return; }
      const fp = j.fingerprint as string | undefined;
      setGhlPins(ghlFieldId && fp ? [...prev.filter((p) => p.fingerprint !== fp), { fingerprint: fp, ghl_field_id: ghlFieldId }] : prev.filter((p) => p.fingerprint !== fieldFingerprint(label)));
      toast(ghlFieldId ? "Mapped to the existing field" : "Back to automatic matching");
    } catch {
      toast("Couldn't save that mapping", "error");
    }
  }

  // An "on Meta" pick ("meta:<id>") is a form that already exists on the Page: viewable but NOT editable —
  // Meta silently ignores writes to a live form. A plain id is one of our saved templates (editable).
  const metaId = editId && editId.startsWith("meta:") ? editId.slice(5) : null;
  const readOnly = !!metaId;
  const templateId = editId && !metaId ? editId : null;

  // Edit/duplicate: load the saved form (or the read-only Meta form) and populate every field.
  useEffect(() => {
    if (!editId) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(metaId ? `/api/lead-forms/meta/${metaId}` : `/api/lead-forms/${editId}`);
        const j = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok || !j.form) { toast(j.error || "Couldn't load that form", "error"); onClose(); return; }
        const f = j.form;
        setName(f.name ?? "");
        const { qs: bqs, std: bstd } = questionsToBuilder(f.questions);
        setQs(bqs);
        setStd({ FULL_NAME: bstd.FULL_NAME, PHONE: bstd.PHONE, EMAIL: bstd.EMAIL });
        const g = f.greeting ?? {};
        setGHeadline(String(g.headline ?? ""));
        setGStyle(g.style === "list" ? "list" : "paragraph");
        setGParagraph(String(g.paragraph ?? ""));
        setGBullets(Array.isArray(g.bullets) && g.bullets.length ? g.bullets.map(String) : [""]);
        const ty = f.thankYou ?? {};
        setTyHeadline(String(ty.headline ?? ""));
        setTyMessage(String(ty.message ?? ""));
        setTyWebsite(String(ty.websiteUrl ?? ""));
        setTyButton(String(ty.buttonText ?? ""));
        setIsAudit(f.isAudit === true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // Depend on editId ONLY. Including the inline `onClose` (new identity every parent render) re-ran this
    // fetch on any parent re-render — e.g. the auto-name pool firing setState — and reset the user's edits (C50).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const setQ = (i: number, patch: Partial<BQ>) => setQs((arr) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addQ = (kind: QKind) =>
    setQs((arr) => [...arr, { kind, label: kind === "appt" ? APPT_LABEL : "", options: kind === "mc" ? ["", ""] : [] }]);
  const removeQ = (i: number) => setQs((arr) => arr.filter((_, j) => j !== i));

  /** Build the payload and POST. mode: "new" (save new) | "update" (overwrite editId) | "once" (mint, don't save). */
  async function submit(mode: "new" | "update" | "once") {
    if (busy) return;
    const formName = name.trim();
    if (!formName) { toast("Name the form"); return; }
    const hasQuestion = qs.some((q) => q.label.trim()) || STD.some((s) => std[s.key]);
    if (!hasQuestion) { toast("Add at least one question or contact field"); return; }

    // Builder questions → API shape (custom questions first, then contact fields — matches Meta ordering).
    const questions = [
      ...qs
        .filter((q) => q.label.trim())
        .map((q) => {
          if (q.kind === "appt") return { type: "DATE_TIME", label: q.label.trim() };
          if (q.kind === "mc") return { type: "CUSTOM", label: q.label.trim(), options: q.options.map((o) => o.trim()).filter(Boolean) };
          return { type: "CUSTOM", label: q.label.trim() }; // short answer (free text)
        }),
      ...STD.filter((s) => std[s.key]).map((s) => ({ type: s.key })),
    ];
    const greeting = { headline: gHeadline.trim(), style: gStyle, paragraph: gParagraph.trim(), bullets: gBullets.map((b) => b.trim()).filter(Boolean) };
    const thankYou = { headline: tyHeadline.trim(), message: tyMessage.trim(), websiteUrl: tyWebsite.trim(), buttonText: tyButton.trim() };

    const body: Record<string, unknown> = { name: formName, questions, greeting, thankYou, isAudit };
    if (mode === "update" && editId) body.id = editId;
    if (mode === "once") body.once = true;

    setBusy(mode);
    try {
      const res = await fetch("/api/lead-forms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { toast(j.error || "Couldn't save the form", "error"); setBusy(null); return; }
      if (j.once && j.metaId) {
        toast(`Using "${formName}" for this launch (not saved)`);
        onDone({ id: `meta:${j.metaId}`, name: `${formName} (unsaved)` });
      } else if (j.form) {
        toast(mode === "update" ? `Form "${formName}" updated` : `Form "${formName}" saved`);
        onDone(j.form);
      } else {
        setBusy(null);
      }
    } catch {
      toast("Couldn't save the form", "error");
      setBusy(null);
    }
  }

  /** Permanently delete this saved form from the library (edit mode only). */
  async function del() {
    if (busy || !editId) return;
    if (!confirm("Delete this form permanently? Ads already using it keep their existing Meta form; this only removes it from your library.")) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/lead-forms/${editId}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { toast(j.error || "Couldn't delete the form", "error"); setBusy(null); return; }
      toast("Form deleted");
      onDeleted?.(editId);
      onClose();
    } catch {
      toast("Couldn't delete the form", "error");
      setBusy(null);
    }
  }

  const Spin = () => <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />;
  const primaryBtn = "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50";
  const ghostBtn = "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50";
  const dangerBtn = "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-rose-500/30 bg-transparent px-2.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/10 focus-visible:outline-none disabled:opacity-50";

  return (
    <>
    <ModalCard
      title={readOnly ? "Lead form · on Meta (read-only)" : templateId ? "Edit lead form" : "Build a lead form"}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {templateId && (
            <button onClick={del} disabled={!!busy || loading} className={dangerBtn} title="Delete this form from your library">
              {busy === "delete" ? <Spin /> : <TrashIcon className="h-3.5 w-3.5" />} Delete
            </button>
          )}
          <button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">Close</button>
          <button onClick={() => setPreviewing(true)} disabled={loading} className={cn(ghostBtn, "mr-auto")} title="See how this form will look to leads">Preview</button>
          {readOnly ? (
            // Can't edit a live Meta form — but you can copy it into an editable saved form.
            <button onClick={() => submit("new")} disabled={!!busy || loading} className={primaryBtn} title="Copy this form into an editable saved form">
              {busy === "new" && <Spin />} {busy === "new" ? "Copying…" : "Save as editable copy"}
            </button>
          ) : (
          <>
          <button onClick={() => submit("once")} disabled={!!busy || loading} className={ghostBtn} title="Use this form for this launch only — not saved to your library">
            {busy === "once" && <Spin />} Use once
          </button>
          {templateId ? (
            <>
              <button onClick={() => submit("new")} disabled={!!busy || loading} className={ghostBtn}>
                {busy === "new" && <Spin />} Save as new
              </button>
              <button onClick={() => submit("update")} disabled={!!busy || loading} className={primaryBtn}>
                {busy === "update" && <Spin />} {busy === "update" ? "Updating…" : "Update"}
              </button>
            </>
          ) : (
            <button onClick={() => submit("new")} disabled={!!busy || loading} className={primaryBtn}>
              {busy === "new" && <Spin />} {busy === "new" ? "Saving…" : "Save form"}
            </button>
          )}
          </>
          )}
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-neutral-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" /> Loading form…
        </div>
      ) : (
        // A form that already lives on Meta is immutable (Meta silently ignores writes), so the whole body
        // is disabled — one fieldset covers every input/button inside.
        <fieldset disabled={readOnly} className="min-w-0 space-y-5">
          <div>
            <Label>Form name</Label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead form — June" className={cn(inputClass, "mt-1")} />
          </div>

          {/* ROI Audit form switch */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <div className="min-w-0">
              <span className="text-sm text-neutral-100">ROI Audit form</span>
              <p className="mt-0.5 text-xs text-neutral-600">Forward this form’s leads to generate an audit.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isAudit}
              onClick={() => setIsAudit((v) => !v)}
              className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none", isAudit ? "bg-accent" : "bg-neutral-700")}
            >
              <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", isAudit ? "translate-x-[18px]" : "translate-x-0.5")} />
            </button>
          </div>

          {/* Greeting */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <Label>Greeting (intro)</Label>
            <input value={gHeadline} onChange={(e) => setGHeadline(e.target.value)} placeholder="Headline" className={cn(inputClass, "mt-2")} />
            <div className="mt-2 inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-xs">
              <button onClick={() => setGStyle("paragraph")} className={cn("rounded px-3 py-1 font-medium transition-colors", gStyle === "paragraph" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>Paragraph</button>
              <button onClick={() => setGStyle("list")} className={cn("rounded px-3 py-1 font-medium transition-colors", gStyle === "list" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>Bullet list</button>
            </div>
            {gStyle === "paragraph" ? (
              <textarea value={gParagraph} onChange={(e) => setGParagraph(e.target.value)} rows={3} placeholder="A short intro paragraph…" className={cn(inputClass, "mt-2")} />
            ) : (
              <div className="mt-2 space-y-1.5">
                {gBullets.map((b, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-700" />
                    <input value={b} onChange={(e) => setGBullets((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Bullet ${i + 1}`} className={cn(inputClass, "py-1")} />
                    {gBullets.length > 1 && (
                      <button onClick={() => setGBullets((arr) => arr.filter((_, j) => j !== i))} aria-label="Remove bullet" className="rounded p-1 text-neutral-600 hover:text-rose-400"><XIcon className="h-3.5 w-3.5" /></button>
                    )}
                  </div>
                ))}
                {gBullets.length < 5 && <button onClick={() => setGBullets((arr) => [...arr, ""])} className="ml-3.5 text-xs text-neutral-500 hover:text-neutral-300">+ add bullet ({gBullets.length}/5)</button>}
              </div>
            )}
          </div>

          {/* Questions */}
          <div>
            <Label>Questions</Label>
            <div className="mt-2 space-y-3">
              {qs.map((q, i) => (
                <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">{KIND_META[q.kind].name}</span>
                    <button onClick={() => removeQ(i)} aria-label="Remove question" className="rounded-md p-1 text-neutral-500 hover:bg-rose-500/10 hover:text-rose-400"><TrashIcon className="h-4 w-4" /></button>
                  </div>
                  <input value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} placeholder="Question text" className={inputClass} />
                  <GhlFieldMap label={q.label} fields={ghlFields} pins={ghlPins} loading={ghlLoading} onPin={pinField} />
                  {q.kind === "mc" ? (
                    <div className="mt-2 space-y-1.5 pl-1">
                      {q.options.map((o, j) => (
                        <div key={j} className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-700" />
                          <input value={o} onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} placeholder={`Answer ${j + 1}`} className={cn(inputClass, "py-1")} />
                          <button onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== j) })} aria-label="Remove answer" className="rounded p-1 text-neutral-600 hover:text-rose-400"><XIcon className="h-3.5 w-3.5" /></button>
                        </div>
                      ))}
                      <button onClick={() => setQ(i, { options: [...q.options, ""] })} className="ml-3.5 text-xs text-neutral-500 hover:text-neutral-300">+ add answer</button>
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-neutral-600">{KIND_META[q.kind].hint}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["mc", "short", "appt"] as QKind[]).map((k) => (
                <button key={k} onClick={() => addQ(k)} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
                  <PlusIcon className="h-3.5 w-3.5" /> {KIND_META[k].name}
                </button>
              ))}
            </div>
          </div>

          {/* Contact details */}
          <div>
            <Label>Contact details to collect</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {STD.map((s) => {
                const on = std[s.key];
                return (
                  <button key={s.key} onClick={() => setStd((p) => ({ ...p, [s.key]: !p[s.key] }))}
                    className={cn("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors", on ? "border-accent/30 bg-accent/10 text-accent" : "border-neutral-700 text-neutral-400 hover:text-neutral-200")}>
                    {on ? "✓ " : ""}{s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* After-submit (thank-you) screen */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <Label>After they submit (the “thank you” screen)</Label>
            <input value={tyHeadline} onChange={(e) => setTyHeadline(e.target.value)} placeholder="Headline — e.g. Thanks, we got your details!" className={cn(inputClass, "mt-2")} />
            <textarea value={tyMessage} onChange={(e) => setTyMessage(e.target.value)} rows={2} placeholder="Message — e.g. We’ll reach out shortly." className={cn(inputClass, "mt-2")} />
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input value={tyWebsite} onChange={(e) => setTyWebsite(e.target.value)} placeholder="Go-to-website link (optional)" className={inputClass} />
              <input value={tyButton} onChange={(e) => setTyButton(e.target.value)} placeholder="Button text — e.g. Book a call" className={inputClass} />
            </div>
          </div>
        </fieldset>
      )}
    </ModalCard>
    {previewing && (
      <LeadFormPreview
        pageName={pageName}
        greeting={{ headline: gHeadline, style: gStyle, paragraph: gParagraph, bullets: gBullets }}
        questions={qs}
        std={{ FULL_NAME: !!std.FULL_NAME, PHONE: !!std.PHONE, EMAIL: !!std.EMAIL }}
        thankYou={{ headline: tyHeadline, message: tyMessage, website: tyWebsite, button: tyButton }}
        onClose={() => setPreviewing(false)}
      />
    )}
    </>
  );
}
