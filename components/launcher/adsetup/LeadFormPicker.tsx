"use client";

import { useState } from "react";
import { cn } from "@/components/ui";
import { Popover, TRIGGER_CLASS } from "./Select";
import { ChevronDownIcon, SearchIcon, PlusIcon, PencilIcon, EyeIcon, CheckIcon } from "../icons";
import type { Option } from "../types";

/**
 * Lead-form picker. Click a form's name to use it for the ad set; click its pencil to open the settings
 * (see how it's built, rename + save, or duplicate via "Save as new" in the builder). "Build a new form"
 * up top. Unsaved "use once" forms (id "meta:…") can be selected but not edited.
 */
export function LeadFormPicker({
  value,
  forms,
  onSelect,
  onBuildNew,
  onEdit,
  placeholder = "Select lead form…",
}: {
  value: string | null;
  forms: Option[];
  onSelect: (id: string) => void;
  onBuildNew: () => void;
  onEdit: (id: string) => void;
  placeholder?: string;
}) {
  const selected = forms.find((f) => f.id === value) ?? null;
  return (
    <Popover
      width={320}
      trigger={({ toggle, ref }) => (
        <button ref={ref} type="button" onClick={toggle} className={cn(TRIGGER_CLASS, selected ? "text-neutral-200" : "text-neutral-500")}>
          <span className="truncate">{selected ? selected.name : placeholder}</span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-neutral-500" />
        </button>
      )}
    >
      {(close) => <PickerBody value={value} forms={forms} onSelect={onSelect} onBuildNew={onBuildNew} onEdit={onEdit} close={close} />}
    </Popover>
  );
}

function PickerBody({
  value,
  forms,
  onSelect,
  onBuildNew,
  onEdit,
  close,
}: {
  value: string | null;
  forms: Option[];
  onSelect: (id: string) => void;
  onBuildNew: () => void;
  onEdit: (id: string) => void;
  close: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = q ? forms.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())) : forms;
  return (
    <>
      <div className="sticky top-0 flex items-center gap-2 bg-[#242424] px-2 py-1.5">
        <SearchIcon className="h-3.5 w-3.5 text-neutral-500" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search forms..."
          className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={() => { onBuildNew(); close(); }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm font-medium text-accent hover:bg-[#2e2e2e]"
      >
        <PlusIcon className="h-3.5 w-3.5" /> Build a new form…
      </button>
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-sm text-neutral-600">{forms.length ? "No matches" : "No forms yet — build one"}</div>
      ) : (
        filtered.map((f) => {
          // "meta:<id>" = a form that already lives on the Page (or was kept from a duplicated ad): used
          // as-is, nothing minted. Meta forms are immutable, so it opens read-only — but it still opens,
          // so you can see exactly how it's built.
          const live = f.id.startsWith("meta:");
          const isSel = f.id === value;
          return (
            <div key={f.id} className={cn("group flex items-center gap-1 rounded pr-1", isSel ? "bg-[#2e2e2e]" : "hover:bg-[#2e2e2e]")}>
              <button
                type="button"
                onClick={() => { onSelect(f.id); close(); }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-neutral-200"
              >
                <CheckIcon className={cn("h-3.5 w-3.5 shrink-0", isSel ? "text-accent opacity-100" : "opacity-0")} />
                <span className="truncate">{f.name}</span>
                {live && (
                  <span className="ml-auto shrink-0 rounded border border-neutral-700 px-1.5 py-px text-[10px] font-medium text-neutral-500" title="Already on your Page — used as-is, no new form created">
                    on Meta
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => { onEdit(f.id); close(); }}
                title={live ? "View this form (read-only — Meta forms can't be edited)" : "View / edit this form"}
                aria-label={live ? `View ${f.name}` : `View or edit ${f.name}`}
                className="shrink-0 rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-700/50 hover:text-neutral-100"
              >
                {/* An eye, not a pencil: a live Meta form can only be looked at. */}
                {live ? <EyeIcon className="h-3.5 w-3.5" /> : <PencilIcon className="h-3.5 w-3.5" />}
              </button>
            </div>
          );
        })
      )}
    </>
  );
}
