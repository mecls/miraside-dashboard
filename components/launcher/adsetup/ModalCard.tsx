"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";
import { XIcon } from "../icons";
import { useBodyScrollLock } from "../useBodyScrollLock";

/** Centered dialog used by the Ad Setup power-tool modals (Add Ads / Bulk Edit / Convert). */
export function ModalCard({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "max-w-md",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBodyScrollLock(); // freeze the page behind this dialog (nested locks are safe — each restores the prior state)
  // Keep the latest onClose in a ref so the focus effect can run ONCE (mount-only). Depending on
  // onClose would re-run this on every parent render — and the ref.current.focus() below would then
  // steal focus from whatever input the user is typing in (e.g. the landing-page URL), one letter at a time.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = (document.activeElement as HTMLElement | null) ?? null;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.(); // return focus to the trigger on close
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/50 p-4 backdrop-blur-[2px] sm:items-center md:left-60" onMouseDown={onClose}>
      {/* Cap the card to the viewport and let only the body scroll — so the header (title + X) and footer stay pinned. */}
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn("flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-lg border border-neutral-800 bg-panel shadow-md focus:outline-none", width)}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
          <div>
            <h3 className="text-sm font-medium text-neutral-50">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-neutral-800 px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
