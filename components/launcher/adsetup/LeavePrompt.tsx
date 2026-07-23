"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function LeavePrompt({
  onContinue,
  onSaveDraft,
  onDiscard,
}: {
  onContinue: () => void;
  onSaveDraft: () => void;
  onDiscard: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onContinue();
    }
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinue]);

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm md:left-60" onMouseDown={onContinue}>
      <div
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Leave Ad Setup"
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-xs focus:outline-none"
      >
        <h3 className="text-base font-semibold text-neutral-50">Leave Ad Setup?</h3>
        <p className="mt-1.5 text-sm text-neutral-400">Your progress will be discarded if you go back. Do you want to save this as a draft first?</p>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button onClick={onContinue} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
            Continue editing
          </button>
          <button
            onClick={onSaveDraft}
            className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none"
          >
            Save as draft
          </button>
          <button onClick={onDiscard} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-rose-500 px-3 text-xs font-medium text-white transition-colors hover:bg-rose-600 focus-visible:outline-none">
            Discard
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
