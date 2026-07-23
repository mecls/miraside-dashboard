"use client";

import { useState } from "react";
import { cn } from "@/components/ui";
import { Popover, TRIGGER_CLASS } from "./Select";
import { ChevronDownIcon, SearchIcon, CheckIcon } from "../icons";
import { fieldFingerprint } from "@/lib/fingerprint";

export type GhlField = { id: string; name: string; fieldKey: string; fingerprint: string };
export type GhlPin = { fingerprint: string; ghl_field_id: string };

/** Where a question's answers will land in GHL: an existing field (matched or pinned), or a new one. */
export function resolveGhlField(label: string, fields: GhlField[], pins: GhlPin[]): { field: GhlField | null; pinned: boolean } {
  const fp = fieldFingerprint(label);
  if (!fp) return { field: null, pinned: false };
  const pin = pins.find((p) => p.fingerprint === fp);
  if (pin) {
    const f = fields.find((x) => x.id === pin.ghl_field_id);
    if (f) return { field: f, pinned: true };
  }
  // Same rule the pipeline uses: match on the fingerprint of the display name OR GHL's own fieldKey.
  const f = fields.find((x) => x.fingerprint === fp || fieldFingerprint(x.fieldKey) === fp);
  return { field: f ?? null, pinned: false };
}

/**
 * The GHL mapping for one question, shown inline in the form builder — so a duplicate custom field is
 * caught BEFORE launching, not after a lead has already been dropped by it.
 */
export function GhlFieldMap({
  label,
  fields,
  pins,
  loading,
  onPin,
}: {
  label: string;
  fields: GhlField[];
  pins: GhlPin[];
  loading: boolean;
  onPin: (label: string, ghlFieldId: string | null) => void;
}) {
  const [q, setQ] = useState("");
  if (!label.trim()) return null;
  if (loading) return <p className="mt-1.5 text-[11px] text-neutral-600">Checking GoHighLevel…</p>;

  const { field, pinned } = resolveGhlField(label, fields, pins);
  const filtered = q ? fields.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())) : fields;

  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
      <span className="shrink-0 text-neutral-600">→ GHL:</span>
      {field ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-emerald-300">
          <CheckIcon className="h-3 w-3 shrink-0" />
          <span className="truncate" title={field.name}>{field.name}</span>
          {pinned && <span className="shrink-0 rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">pinned</span>}
        </span>
      ) : (
        <span className="shrink-0 text-amber-300">new field will be created</span>
      )}
      <Popover
        width={300}
        align="right"
        trigger={({ toggle, ref }) => (
          <button ref={ref} type="button" onClick={toggle} className="ml-auto shrink-0 font-medium text-neutral-500 underline-offset-2 hover:text-accent hover:underline">
            {field ? "change" : "use existing"}
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="sticky top-0 flex items-center gap-2 bg-[#242424] px-2 py-1.5">
              <SearchIcon className="h-3.5 w-3.5 text-neutral-500" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search fields..."
                className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => { onPin(label, null); close(); }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-neutral-300 hover:bg-[#2e2e2e]"
            >
              Auto — match by name{field && !pinned ? " (current)" : ""}
            </button>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-600">No matches</div>
            ) : (
              filtered.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => { onPin(label, f.id); close(); }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-[#2e2e2e]",
                    f.id === field?.id ? "text-accent" : "text-neutral-200"
                  )}
                >
                  <CheckIcon className={cn("h-3.5 w-3.5 shrink-0", f.id === field?.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{f.name}</span>
                </button>
              ))
            )}
          </>
        )}
      </Popover>
    </div>
  );
}
