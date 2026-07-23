"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";
import { CheckIcon, LockIcon } from "../icons";
import { REQUIRED_COLUMNS, OPTIONAL_COLUMNS, COLUMN_LABEL } from "./constants";
import type { ColumnKey } from "../types";

// v2: lean default column set (Description/WhatsApp/IG/Enhancements/UTM/Lead Form hidden by default).
export const COLS_STORAGE_KEY = "adsetup_visible_columns_v2";

export function ColumnPicker({
  visible,
  onChange,
  onClose,
}: {
  visible: ColumnKey[];
  onChange: (cols: ColumnKey[]) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState<Set<ColumnKey>>(new Set(visible.filter((c) => OPTIONAL_COLUMNS.includes(c))));
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle(c: ColumnKey) {
    setLocal((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function save() {
    const cols = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS.filter((c) => local.has(c))];
    onChange(cols);
    try {
      localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols));
    } catch {
      // ignore (private mode etc.)
    }
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[70]" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Choose columns"
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute right-4 top-14 flex max-h-[80vh] w-72 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs focus:outline-none"
      >
        <div className="overflow-y-auto p-2">
          <div className="mono-label px-2 py-1">Required columns</div>
          {REQUIRED_COLUMNS.map((c) => (
            <div key={c} className="flex items-center justify-between px-2 py-1.5 text-sm text-neutral-300">
              <span className="flex items-center gap-2">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-accent text-neutral-950">
                  <CheckIcon className="h-3 w-3" />
                </span>
                {COLUMN_LABEL[c]}
              </span>
              <LockIcon className="h-3.5 w-3.5 text-neutral-600" />
            </div>
          ))}

          <div className="mono-label mt-1 px-2 py-1">Optional columns</div>
          {OPTIONAL_COLUMNS.map((c) => {
            const on = local.has(c);
            return (
              <button
                key={c}
                onClick={() => toggle(c)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-surface-200"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded ring-1 ring-inset",
                    on ? "bg-accent text-neutral-950 ring-accent" : "bg-transparent text-transparent ring-neutral-600"
                  )}
                >
                  <CheckIcon className="h-3 w-3" />
                </span>
                {COLUMN_LABEL[c]}
              </button>
            );
          })}
        </div>
        <div className="border-t border-neutral-800 p-2">
          <button onClick={save} className="flex h-7 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none">
            Save Columns
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
