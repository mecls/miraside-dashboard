"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { cn } from "@/components/ui";

export interface AppSelectOption {
  value: string;
  label: string;
  /** Optional leading status dot — a Tailwind bg-* class (e.g. "bg-amber-400"). Shown in the trigger + menu. */
  dot?: string;
}

/**
 * Styled dropdown matching the dashboard (native <select> popups are OS-drawn and can't be themed).
 * Trigger mirrors the app's input look; the menu is our own dark panel. The menu is FIXED-positioned
 * from the trigger's viewport rect so overflow containers (scrollable tables/panels) can't clip it —
 * it closes on outside click, Escape, scroll, or resize.
 */
export function AppSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Select…",
  className,
}: {
  value: string;
  options: AppSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Extra trigger classes — width/height overrides (defaults to the app's 34px input look). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const menuH = Math.min(options.length * 32 + 10, 288);
    const top = r.bottom + 4 + menuH > window.innerHeight ? Math.max(8, r.top - menuH - 4) : r.bottom + 4;
    setPos({ top, left: r.left, width: r.width });
    setOpen(true);
  }

  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "inline-flex h-[34px] items-center justify-between gap-2 rounded-md border border-neutral-700 bg-surface-200 pl-3 pr-2.5 text-sm text-neutral-100 transition-colors hover:border-neutral-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {current?.dot && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", current.dot)} />}
          <span className={cn("truncate", !current && "text-neutral-600")}>{current?.label ?? placeholder}</span>
        </span>
        <svg
          className={cn("h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform", open && "rotate-180")}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <div
          role="listbox"
          className="fixed z-50 max-h-72 overflow-y-auto rounded-md border border-[#333333] bg-surface-200 p-1 shadow-xl shadow-black/40"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
          onClick={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-neutral-800",
                o.value === value ? "bg-neutral-800/60 text-neutral-100" : "text-neutral-300"
              )}
            >
              {o.dot && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", o.dot)} />}
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
