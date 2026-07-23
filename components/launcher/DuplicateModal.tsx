"use client";

import { useRef, useState } from "react";
import { cn } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { ModalCard } from "./adsetup/ModalCard";
import { Select } from "./adsetup/Select";
import { CTA_OPTIONS } from "./adsetup/constants";
import { ImageIcon, FolderIcon, CopyIcon } from "./icons";
import type { ExistingAd, AdSetupData } from "./types";

type Mode = "exact" | "recompose";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

function StatusDot({ status }: { status: string }) {
  const s = (status || "").toUpperCase();
  const tone = s === "ACTIVE" ? "bg-emerald-400" : s === "PAUSED" ? "bg-amber-400" : "bg-neutral-500";
  return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} title={s || "—"} />;
}

/**
 * Duplicate existing ads — two flavors, both of which open the Ad Setup editor (nothing is created
 * until you Launch there; all PAUSED):
 *  • Exact copies: open the selected ad(s) as-is (image + copy + ad set) for tweaking.
 *  • New creative: open ONE ad's setup (its ad set + kept lead form + link) with a new image + copy.
 * Full destination/audience control lives in the editor — not here.
 */
export function DuplicateModal({
  ads,
  onOpenInEditor,
  onOpenRecomposeInEditor,
  onClose,
}: {
  ads: ExistingAd[];
  data: AdSetupData;
  onOpenInEditor: (ids: string[]) => Promise<{ ok: boolean; error?: string }>;
  onOpenRecomposeInEditor: (p: { sourceId: string; name: string; message: string; headline: string; cta: string; imageDataUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("exact");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set()); // exact: db ids
  const [sourceId, setSourceId] = useState<string | null>(null); // recompose: db id
  const [busy, setBusy] = useState(false);
  // recompose creative
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [headline, setHeadline] = useState("");
  const [cta, setCta] = useState("LEARN_MORE");
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q ? ads.filter((a) => a.name.toLowerCase().includes(q)) : ads;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function pickSource(a: ExistingAd) {
    setSourceId(a.id);
    if (!name.trim()) setName(`${a.name} (copy)`);
  }
  async function onImage(file: File | null) {
    if (!file) return;
    setImageName(file.name);
    setImageData(await fileToDataUrl(file));
  }

  // Open the selected ads in the Ad Setup editor (pre-filled) — nothing is created until the user
  // hits Launch there (all paused). On success the parent swaps to the grid and unmounts this modal.
  async function runExact() {
    if (busy || !selected.size) return;
    setBusy(true);
    const r = await onOpenInEditor([...selected]);
    if (!r.ok) { toast(r.error || "Couldn't load those ads", "error"); setBusy(false); }
  }

  // Open the source ad's setup in the editor with the new image + copy (full destination control there).
  async function runRecompose() {
    if (busy) return;
    if (!sourceId) { toast("Pick an ad to duplicate"); return; }
    if (!name.trim()) { toast("Name the new ad"); return; }
    if (!imageData) { toast("Add an image"); return; }
    setBusy(true);
    const r = await onOpenRecomposeInEditor({ sourceId, name: name.trim(), message: message.trim(), headline: headline.trim(), cta, imageDataUrl: imageData });
    if (!r.ok) { toast(r.error || "Couldn't open the editor", "error"); setBusy(false); }
  }

  const footer =
    mode === "exact" ? (
      <>
        <span className="mr-auto text-xs text-neutral-500">{selected.size} selected</span>
        <button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">Cancel</button>
        <button
          onClick={runExact}
          disabled={busy || !selected.size}
          className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50"
        >
          <CopyIcon className="h-4 w-4" /> {busy ? "Opening…" : `Open ${selected.size || ""} in editor`}
        </button>
      </>
    ) : (
      <>
        <button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">Cancel</button>
        <button
          onClick={runRecompose}
          disabled={busy || !sourceId || !imageData}
          title={!sourceId ? "Pick an ad first" : !imageData ? "Add a new image first" : undefined}
          className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open in editor"}
        </button>
      </>
    );

  return (
    <ModalCard title="Duplicate existing ads" onClose={onClose} width="max-w-lg" footer={busy ? undefined : footer}>
      {busy ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
          <div className="text-sm font-medium text-neutral-200">
            {mode === "exact" ? `Opening ${selected.size} ad${selected.size === 1 ? "" : "s"} in the editor…` : "Opening the editor…"}
          </div>
        </div>
      ) : (
      <>
      {/* Mode toggle */}
      <div className="inline-flex rounded-lg border border-neutral-800 p-0.5 text-xs">
        <button onClick={() => setMode("exact")} className={cn("rounded-md px-3 py-1.5 font-medium", mode === "exact" ? "bg-accent/15 text-accent" : "text-neutral-500 hover:text-neutral-300")}>
          Exact copies
        </button>
        <button onClick={() => setMode("recompose")} className={cn("rounded-md px-3 py-1.5 font-medium", mode === "recompose" ? "bg-accent/15 text-accent" : "text-neutral-500 hover:text-neutral-300")}>
          New creative
        </button>
      </div>

      {ads.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-neutral-800 px-4 py-8 text-center text-sm text-neutral-500">
          No ads yet to duplicate.
        </div>
      ) : (
        <>
          {/* Search */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ads…"
            className="mt-4 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
          />
          {/* Ad list */}
          <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-neutral-800 divide-y divide-neutral-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-xs text-neutral-600">No ads match.</div>}
            {filtered.map((a) => {
              const isSel = mode === "exact" ? selected.has(a.id) : sourceId === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => (mode === "exact" ? toggle(a.id) : pickSource(a))}
                  className={cn("flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-200/50", isSel && "bg-accent/10")}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center border",
                      mode === "exact" ? "rounded" : "rounded-full",
                      isSel ? "border-accent bg-accent text-neutral-950" : "border-neutral-600"
                    )}
                  >
                    {isSel && <span className={mode === "exact" ? "text-[10px] leading-none" : "h-1.5 w-1.5 rounded-full bg-neutral-950"}>{mode === "exact" ? "✓" : ""}</span>}
                  </span>
                  <span className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-neutral-800">
                    {a.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-neutral-600"><ImageIcon className="h-4 w-4" /></span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-200">{a.name}</span>
                  </span>
                  <StatusDot status={a.status} />
                </button>
              );
            })}
          </div>

          {/* Recompose creative form */}
          {mode === "recompose" && sourceId && (
            <div className="mt-4 space-y-3 border-t border-neutral-800 pt-4">
              <div>
                <label className="mono-label block">New ad name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
                />
              </div>
              <div>
                <label className="mono-label block">Primary text</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Write your primary text…"
                  className="mt-1 w-full rounded-md border border-neutral-700 bg-surface-200 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mono-label block">Headline</label>
                  <input
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    placeholder="Optional"
                    className="mt-1 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
                  />
                </div>
                <div>
                  <label className="mono-label block">Button</label>
                  <div className="mt-1">
                    <Select value={cta} onChange={(v) => setCta(v ?? "LEARN_MORE")} options={CTA_OPTIONS} placeholder="Select CTA…" />
                  </div>
                </div>
              </div>
              <div>
                <label className="mono-label block">New image</label>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="mt-1 flex h-[34px] w-full items-center gap-3 rounded-md border border-dashed border-neutral-700 bg-surface-200 px-3 text-left text-sm text-neutral-400 transition-colors hover:border-accent hover:text-accent"
                >
                  <FolderIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{imageName || "Choose an image…"}</span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => { onImage(e.target.files?.[0] ?? null); e.target.value = ""; }}
                />
              </div>
            </div>
          )}
        </>
      )}
      </>
      )}
    </ModalCard>
  );
}
