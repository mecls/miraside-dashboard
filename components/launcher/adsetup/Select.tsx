"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";
import { ChevronDownIcon, CheckIcon, SearchIcon } from "../icons";
import type { Option } from "../types";

export const TRIGGER_CLASS =
  "flex h-[34px] w-full items-center justify-between gap-2 rounded-md border border-neutral-700 bg-surface-200 px-3 text-left text-sm transition-colors hover:border-neutral-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** A small filled checkbox visual (not a real input — the parent button handles clicks). */
export function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded ring-1 ring-inset",
        checked ? "bg-accent text-neutral-950 ring-accent" : "bg-transparent text-transparent ring-neutral-600"
      )}
    >
      <CheckIcon className="h-3 w-3" />
    </span>
  );
}

/**
 * Portal-anchored popover so dropdowns in the horizontally-scrolling table are never clipped.
 * Closes on outside-click, Escape, or any scroll.
 */
export function Popover({
  trigger,
  children,
  width,
  align = "left",
}: {
  trigger: (p: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node) || popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop a parent modal's window-level Escape handler from also firing (layered close).
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onScroll = (e: Event) => {
      // Don't close when the user scrolls inside the popover's own list.
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const w = width ?? (rect ? Math.max(rect.width, 220) : 220);
  const left = rect ? (align === "right" ? Math.max(8, rect.right - w) : rect.left) : 0;

  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: btnRef })}
      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: "fixed", top: rect.bottom + 4, left, width: w }}
            className="z-[100] max-h-80 overflow-auto rounded-md border border-[#333333] bg-[#242424] p-1 shadow-lg"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </>
  );
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  searchable,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  options: Option[];
  placeholder: string;
  searchable?: boolean;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const selected = options.find((o) => o.id === value);

  if (disabled || options.length === 0) {
    // Nothing to pick — render an inert trigger showing the placeholder (e.g. "No Instagram accounts").
    return (
      <div className={cn(TRIGGER_CLASS, "cursor-default text-neutral-600 hover:border-neutral-700")}>
        <span className="truncate">{placeholder}</span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-neutral-600" />
      </div>
    );
  }

  return (
    <Popover
      trigger={({ toggle, ref }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          className={cn(TRIGGER_CLASS, selected ? "text-neutral-200" : "text-neutral-500")}
        >
          <span className="truncate">{selected ? selected.name : placeholder}</span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-neutral-500" />
        </button>
      )}
    >
      {(close) => {
        const filtered = searchable && q ? options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())) : options;
        return (
          <>
            {searchable && (
              <div className="sticky top-0 flex items-center gap-2 bg-[#242424] px-2 py-1.5">
                <SearchIcon className="h-3.5 w-3.5 text-neutral-500" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search..."
                  className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
                />
              </div>
            )}
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-600">No matches</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => {
                    onChange(o.id);
                    setQ("");
                    close();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-[#2e2e2e]",
                    o.id === value ? "text-accent" : "text-neutral-200"
                  )}
                >
                  <CheckIcon className={cn("h-3.5 w-3.5 shrink-0", o.id === value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{o.name}</span>
                </button>
              ))
            )}
          </>
        );
      }}
    </Popover>
  );
}
