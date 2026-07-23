"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toaster";
import { AppSelect } from "./AppSelect";

const CTAS = ["SIGN_UP", "LEARN_MORE", "APPLY_NOW", "GET_QUOTE", "SUBSCRIBE", "CONTACT_US", "DOWNLOAD", "GET_OFFER"];
const label = "mono-label block mb-1";
const input = "mt-1 w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20 h-[34px]";

type SavedForm = { id: string; name: string };

/** Ad-level Edit + Publish: name · replace image (auto-crop toggle) · form (keep/saved) · archive form · preview. */
export function AdEditPanel({ dbId, name: initialName, onClose }: { dbId: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState(initialName);
  const [message, setMessage] = useState("");
  const [headline, setHeadline] = useState("");
  const [cta, setCta] = useState("LEARN_MORE");
  const [autoCrop, setAutoCrop] = useState(true);
  const [currentForm, setCurrentForm] = useState<{ id: string; name: string | null } | null>(null);
  const [savedForms, setSavedForms] = useState<SavedForm[]>([]);
  const [imageHash, setImageHash] = useState<string | null>(null); // current image

  // edits
  const [formMode, setFormMode] = useState<"keep" | "saved">("keep");
  const [templateId, setTemplateId] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");

  // original values to detect changes
  const [orig, setOrig] = useState({ message: "", headline: "", cta: "LEARN_MORE", autoCrop: true });

  const [previews, setPreviews] = useState<{ format: string; body: string }[]>([]);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/ads/settings?dbId=${encodeURIComponent(dbId)}&level=ad`);
        const j = await res.json();
        if (!alive) return;
        if (!res.ok || !j.ok) { setErr(j.error ?? "Couldn't load this ad."); return; }
        const s = j.settings;
        setName(s.name || initialName);
        setMessage(s.message || ""); setHeadline(s.headline || ""); setCta(s.cta || "LEARN_MORE");
        setAutoCrop(s.autoCrop !== false); setImageHash(s.imageHash ?? null);
        setCurrentForm(s.currentForm ?? null); setSavedForms(s.savedForms ?? []);
        setOrig({ message: s.message || "", headline: s.headline || "", cta: s.cta || "LEARN_MORE", autoCrop: s.autoCrop !== false });
      } catch { if (alive) setErr("Couldn't load this ad."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [dbId, initialName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageName(file.name);
    const r = new FileReader();
    r.onload = () => { const b64 = String(r.result); setImageBase64(b64); preview(b64); };
    r.readAsDataURL(file);
  }

  async function preview(base64Override?: string) {
    const img = base64Override ?? imageBase64;
    if (!img && !imageHash) { setErr("No image to preview."); return; }
    setPreviewing(true); setErr(null);
    try {
      const res = await fetch("/api/ads/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, headline, callToAction: cta, autoCrop, imageBase64: img || undefined, imageHash: img ? undefined : imageHash }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error ?? "Couldn't render preview.");
      else setPreviews(j.previews ?? []);
    } catch { setErr("Network error generating preview."); }
    finally { setPreviewing(false); }
  }

  const rebuild = !!imageBase64 || formMode === "saved" || autoCrop !== orig.autoCrop || message !== orig.message || headline !== orig.headline || cta !== orig.cta;

  async function publish() {
    setErr(null);
    if (formMode === "saved" && !templateId) { setErr("Pick a saved form."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/ads/manage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbId, level: "ad", action: "edit_ad", name, rebuild, imageBase64: imageBase64 || undefined, formMode, templateId, message, headline, cta, autoCrop }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error ?? "Publish failed.");
      else { toast(rebuild ? "Ad updated" : "Ad renamed"); router.refresh(); onClose(); }
    } catch { setErr("Network error."); }
    finally { setBusy(false); }
  }

  async function archiveForm() {
    if (!confirm("Archive this ad's instant form? Do this only if you're retiring the form — it can stop the ad collecting leads.")) return;
    setArchiving(true); setErr(null);
    try {
      const res = await fetch("/api/ads/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dbId, level: "ad", action: "archive_form" }) });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error ?? "Couldn't archive the form.");
      else { toast("Form archived"); setCurrentForm(null); setFormMode("saved"); setTemplateId(""); } // must pick a new form for any rebuild
    } catch { setErr("Network error."); }
    finally { setArchiving(false); }
  }

  return (
    <div className="fixed inset-0 z-50" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 max-h-[88vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-neutral-800 bg-panel p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="text-sm font-medium text-neutral-50">Edit ad</div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-500 hover:bg-surface-200 hover:text-neutral-100">✕</button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-neutral-600">Loading this ad…</p>
        ) : (
          <div className="mt-5 space-y-4">
            <div><label className={label}>Ad name</label><input className={input} value={name} onChange={(e) => setName(e.target.value)} /></div>

            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs space-y-3">
              <div className="mono-label">Instant form</div>
              <div className="text-xs text-neutral-500">Current: <span className="text-neutral-300">{currentForm ? (currentForm.name || currentForm.id) : "none"}</span></div>
              <div className="flex gap-2">
                <label className={`flex-1 cursor-pointer rounded-md px-3 py-1.5 text-center text-sm ${formMode === "keep" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"}`}><input type="radio" className="hidden" checked={formMode === "keep"} onChange={() => { setFormMode("keep"); setTemplateId(""); }} />Keep current</label>
                <label className={`flex-1 cursor-pointer rounded-md px-3 py-1.5 text-center text-sm ${formMode === "saved" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100"}`}><input type="radio" className="hidden" checked={formMode === "saved"} onChange={() => setFormMode("saved")} />Use a saved form</label>
              </div>
              {formMode === "saved" && (savedForms.length ? (
                <AppSelect
                  value={templateId}
                  onChange={setTemplateId}
                  className="mt-1 w-full"
                  placeholder="Pick a saved form…"
                  options={savedForms.map((f) => ({ value: f.id, label: f.name }))}
                />
              ) : <p className="text-xs text-amber-400/80">No saved forms yet — build one in the Ads Launcher.</p>)}{/* /create was deleted (C66) */}
              {currentForm && (
                <button type="button" onClick={archiveForm} disabled={archiving} className="inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2 text-xs font-medium text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 focus-visible:outline-none disabled:opacity-50">{archiving ? "Archiving…" : "Archive current form"}</button>
              )}
            </div>

            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs space-y-3">
              <div className="mono-label">Creative</div>
              <div><label className={label}>Primary text</label><textarea className="mt-1 w-full rounded-md border border-neutral-700 bg-surface-200 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20" rows={2} value={message} onChange={(e) => { setMessage(e.target.value); setPreviews([]); }} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>Headline</label><input className={input} value={headline} onChange={(e) => { setHeadline(e.target.value); setPreviews([]); }} /></div>
                <div>
                  <label className={label}>Button</label>
                  <div className="mt-1">
                    <AppSelect
                      value={cta}
                      onChange={(v) => { setCta(v); setPreviews([]); }}
                      className="w-full"
                      options={CTAS.map((c) => ({ value: c, label: c.replace(/_/g, " ").toLowerCase() }))}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className={label}>Replace image (optional)</label>
                <input type="file" accept="image/*" onChange={onImage} className="mt-1 block w-full text-sm text-neutral-400 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-sm file:text-neutral-200" />
                {imageName && <div className="mt-1 text-xs text-neutral-500">{imageName}</div>}
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={autoCrop} onChange={(e) => { setAutoCrop(e.target.checked); setPreviews([]); }} /> Auto-crop image to fit each placement</label>
              <p className="text-xs text-neutral-600">Standard enhancements are on. Changing the image, form, copy or auto-crop rebuilds the ad&apos;s creative and re-submits it for review.</p>
            </div>

            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <div className="mono-label">Preview — all placements</div>
                <button type="button" onClick={() => preview()} disabled={previewing} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50">{previewing ? "Updating…" : previews.length ? "Refresh" : "Show"}</button>
              </div>
              {previews.length > 0 && (
                <div className="mt-3 flex gap-4 overflow-x-auto pb-2">
                  {previews.map((p) => (
                    <div key={p.format} className="shrink-0 space-y-1">
                      <div className="mono-label">{p.format.replace(/_/g, " ").toLowerCase()}</div>
                      {/* Only inject Meta's expected sandboxed <iframe> preview — never arbitrary markup, and never a <script> (C53). */}
                      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-white" dangerouslySetInnerHTML={{ __html: /<iframe[\s>]/i.test(p.body || "") && !/<script/i.test(p.body || "") ? p.body : "" }} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {err && <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">{err}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} disabled={busy} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50">Cancel</button>
              <button onClick={publish} disabled={busy} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50">{busy ? "Publishing…" : rebuild ? "Publish (rebuilds ad)" : "Publish"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
