"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui";
import { ArrowLeftIcon, ArrowRightIcon, XIcon, CheckIcon, VideoIcon } from "./icons";
import { useBodyScrollLock } from "./useBodyScrollLock";
import type { UploadedCreative } from "./types";

// Single shared id source so row/group ids never collide across modals, re-opens, or a resumed draft's
// persisted ids (a module counter reset to 0 per load would re-issue grp_1 and clash) (C49).
export const newGroupId = () => `grp_${crypto.randomUUID()}`;

/** Full-screen overlay + large panel shared by the grouping modals. Handles Escape, focus-on-open, a Tab focus-trap, and focus restore. */
export function ModalShell({
  children,
  onBackdrop,
  ariaLabel,
}: {
  children: React.ReactNode;
  onBackdrop: () => void;
  ariaLabel: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(); // freeze the page behind this overlay
  useEffect(() => {
    const prevFocus = (document.activeElement as HTMLElement | null) ?? null;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onBackdrop();
        return;
      }
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const f = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [onBackdrop]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-[2px] sm:items-center md:left-60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackdrop();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-panel shadow-md focus:outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({
  title,
  adCount,
  onBack,
  onClose,
}: {
  title: string;
  adCount: number;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
      <button
        onClick={onBack}
        aria-label="Back"
        className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeftIcon className="h-4 w-4" />
      </button>
      <div className="flex-1">
        <h2 className="text-base font-semibold text-neutral-50">{title}</h2>
        <p className="text-xs text-neutral-500">
          {adCount} ad{adCount === 1 ? "" : "s"} will be created
        </p>
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ModalFooter({ adCount, onContinue, disabled, note }: { adCount: number; onContinue: () => void; disabled?: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-neutral-800 px-5 py-4">
      <span className="text-sm text-neutral-500">
        {note ?? `${adCount} ad${adCount === 1 ? "" : "s"} will be created`}
      </span>
      <button
        onClick={onContinue}
        disabled={disabled ?? adCount === 0}
        className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50"
      >
        Continue to Ad Setup <ArrowRightIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-neutral-800" />
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-600">{label}</span>
      <div className="h-px flex-1 bg-neutral-800" />
    </div>
  );
}

/** A selectable creative tile (a real toggle button) with a ratio badge. Used in the ungrouped grid. */
export function CreativeThumb({
  creative,
  ratio,
  selected,
  onToggle,
  disabled,
}: {
  creative: UploadedCreative;
  ratio?: string;
  selected?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}) {
  const media =
    creative.kind === "image" ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={creative.previewUrl} alt="" className="h-full w-full object-cover" />
    ) : (
      <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-400">
        <VideoIcon className="h-6 w-6" />
      </div>
    );
  const badge = ratio ? (
    <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">{ratio}</span>
  ) : null;

  if (!onToggle) {
    return (
      <div className="relative h-28 w-28 overflow-hidden rounded-lg ring-1 ring-inset ring-neutral-700">
        {media}
        {badge}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={!!selected}
      aria-label={creative.name}
      className={cn(
        "relative h-28 w-28 overflow-hidden rounded-lg ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
        selected ? "ring-2 ring-accent" : "ring-neutral-700"
      )}
    >
      {media}
      <span
        className={cn(
          "absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md ring-1",
          selected ? "bg-accent text-neutral-950 ring-accent" : "bg-black/40 text-transparent ring-white/70"
        )}
      >
        <CheckIcon className="h-3 w-3" />
      </span>
      {badge}
    </button>
  );
}

/** A formed group (multi-ratio ad / flexible ad) shown above the ungrouped grid, with an Ungroup action. */
export function GroupCard({
  label,
  creatives,
  ratios,
  onUngroup,
}: {
  label: string;
  creatives: UploadedCreative[];
  ratios: Record<string, string>;
  onUngroup: () => void;
}) {
  const shown = creatives.slice(0, 3);
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex">
          {shown.map((c, i) => (
            <div
              key={c.id}
              className={cn("relative h-16 w-16 overflow-hidden rounded-lg ring-1 ring-inset ring-neutral-700", i > 0 && "-ml-5")}
            >
              {c.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-400">
                  <VideoIcon className="h-5 w-5" />
                </div>
              )}
              {ratios[c.id] && (
                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white">
                  {ratios[c.id]}
                </span>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={onUngroup}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-neutral-400 transition-colors hover:bg-surface-200 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Ungroup
        </button>
      </div>
      <div className="mt-3 text-xs text-neutral-400">{label}</div>
    </div>
  );
}
