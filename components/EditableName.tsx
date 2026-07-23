"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toaster";

/**
 * Inline-editable name for a campaign / ad set / ad. Saving writes the new name to
 * Facebook (Meta API) and mirrors it locally. Name-only — never touches status or spend.
 * `onClick` (when given) keeps the drill-in behaviour on the name text.
 */
export function EditableName({
  dbId,
  level,
  name,
  onClick,
  linkClass = "block max-w-[240px] truncate font-medium text-neutral-100 hover:text-neutral-300 hover:underline", // truncate long Meta names so they don't blow out the table (C60)
}: {
  dbId: string;
  level: "campaign" | "adset" | "ad";
  name: string;
  onClick?: () => void;
  linkClass?: string;
}) {
  const router = useRouter();
  const [display, setDisplay] = useState(name);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep the shown name in sync with the prop (e.g. after a background sync or another rename),
  // without clobbering an edit in progress.
  useEffect(() => {
    if (!editing) {
      setDisplay(name);
      setValue(name);
    }
  }, [name, editing]);

  async function save() {
    const nm = value.trim();
    if (!nm) { setErr("Enter a name."); return; }
    if (nm === display) { setEditing(false); setErr(null); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/ads/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbId, level, action: "rename", name: nm }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setErr(j.error ?? "Rename failed.");
      } else {
        toast("Renamed");
        setDisplay(nm);
        setEditing(false);
        router.refresh();
      }
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setEditing(false);
    setValue(display);
    setErr(null);
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={value}
          disabled={busy}
          maxLength={400}
          aria-label={`Rename ${level}`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          className="h-7 w-56 rounded-md border border-neutral-700 bg-surface-200 px-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
        />
        <button type="button" onClick={save} disabled={busy} className="inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50">{busy ? "…" : "Save"}</button>
        <button type="button" onClick={cancel} disabled={busy} className="inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none disabled:opacity-50">Cancel</button>
        {err && <span className="text-[11px] text-rose-400">{err}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {onClick ? (
        <button type="button" onClick={onClick} className={linkClass}>{display}</button>
      ) : (
        <span className={linkClass}>{display}</span>
      )}
      <button
        type="button"
        title="Rename"
        aria-label="Rename"
        onClick={(e) => { e.stopPropagation(); setValue(display); setEditing(true); }}
        className="text-neutral-600 transition-colors hover:text-neutral-300"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </span>
  );
}
