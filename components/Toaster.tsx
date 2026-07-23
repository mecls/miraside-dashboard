"use client";

import { useEffect, useRef, useState } from "react";

type ToastType = "success" | "error";
type ToastOpts = {
  /** Label for an inline action button, e.g. "Undo". Requires onAction. */
  actionLabel?: string;
  /** Runs on action click, then dismisses. Must close over values captured AT CLICK TIME — the row
   *  that fired the toast may already be unmounted when this runs. */
  onAction?: () => void | Promise<void>;
  /** Milliseconds before auto-dismiss (default 3500). Undo toasts need longer — the operator has to
   *  read it, realise the mistake and reach for the mouse. */
  duration?: number;
};
type Toast = { id: number; message: string; type: ToastType } & ToastOpts;
let counter = 0;

/**
 * Fire a small toast from any client component. Pass "error" for failures so they render with a rose X
 * instead of the green success check — an error toast must never look like a success (C57).
 *   toast("Ad updated") · toast("Couldn't save", "error")
 *   toast("Task deleted", "success", { actionLabel: "Undo", onAction: restore, duration: 8000 })
 */
export function toast(message: string, type: ToastType = "success", opts: ToastOpts = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message, type, ...opts } }));
}

/** Bottom-right toasts; auto-dismiss after a few seconds, dismissable. Mounted once in the layout. */
export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Timers are cancelled when a toast is dismissed early, so an action click can't be followed by a
  // stray timeout removing a DIFFERENT toast that reused the slot.
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    function onToast(e: Event) {
      const detail = (e as CustomEvent).detail ?? {};
      const message = detail.message;
      if (!message) return;
      const type: ToastType = detail.type === "error" ? "error" : "success";
      const id = ++counter;
      const hasAction = typeof detail.onAction === "function" && !!detail.actionLabel;
      const ms = typeof detail.duration === "number" && detail.duration > 0 ? detail.duration : 3500;
      setToasts((t) => [
        ...t,
        {
          id,
          message,
          type,
          ...(hasAction ? { actionLabel: String(detail.actionLabel), onAction: detail.onAction, duration: ms } : {}),
        },
      ]);
      const handle = window.setTimeout(() => {
        timers.current.delete(id);
        setToasts((t) => t.filter((x) => x.id !== id));
      }, ms);
      timers.current.set(id, handle);
    }
    window.addEventListener("app-toast", onToast as EventListener);
    const pending = timers.current;
    return () => {
      window.removeEventListener("app-toast", onToast as EventListener);
      pending.forEach((h) => window.clearTimeout(h));
      pending.clear();
    };
  }, []);

  const dismiss = (id: number) => {
    const h = timers.current.get(id);
    if (h) {
      window.clearTimeout(h);
      timers.current.delete(id);
    }
    setToasts((t) => t.filter((x) => x.id !== id));
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.type === "error" ? "alert" : "status"}
          className="pointer-events-auto relative flex items-center gap-2.5 overflow-hidden rounded-md border border-[#333333] bg-[#242424] px-4 py-3 text-sm text-neutral-100 shadow-lg"
        >
          <span className={t.type === "error" ? "shrink-0 text-rose-400" : "shrink-0 text-accent"}>
            {t.type === "error" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            )}
          </span>
          <span className="whitespace-nowrap">{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button
              onClick={() => {
                const run = t.onAction;
                dismiss(t.id); // dismiss FIRST so a double-click can't fire the action twice
                void run?.();
              }}
              className="ml-1 shrink-0 rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 py-1 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50"
            >
              {t.actionLabel}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} className="ml-1 shrink-0 text-neutral-500 transition-colors hover:text-neutral-300" aria-label="Dismiss">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
          {t.actionLabel && t.duration ? (
            <span aria-hidden className="toast-countdown pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent/60" style={{ animation: `toastbar ${t.duration}ms linear forwards` }} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
