"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";
import { XIcon, ArrowLeftIcon, ArrowRightIcon } from "../icons";
import { useBodyScrollLock } from "../useBodyScrollLock";

type PQ = { kind: "mc" | "short" | "appt"; label: string; options: string[] };

/**
 * Phone-mockup preview of the instant form as leads actually see it — one screen per step, matching
 * Meta's real flow: Intro → each question on its OWN screen → Contact info (+ privacy) → Completion.
 * Page through it with prev/next; nothing needs filling in. Rendered light, like the real Meta form.
 */
type Page =
  | { kind: "intro"; label: string }
  | { kind: "question"; label: string; q: PQ }
  | { kind: "contact"; label: string }
  | { kind: "completion"; label: string };

export function LeadFormPreview({
  pageName,
  greeting,
  questions,
  std,
  thankYou,
  onClose,
}: {
  pageName: string;
  greeting: { headline: string; style: "paragraph" | "list"; paragraph: string; bullets: string[] };
  questions: PQ[];
  std: { FULL_NAME: boolean; PHONE: boolean; EMAIL: boolean };
  thankYou: { headline: string; message: string; website: string; button: string };
  onClose: () => void;
}) {
  useBodyScrollLock();

  const hasIntro = !!(greeting.headline.trim() || greeting.paragraph.trim() || greeting.bullets.some((b) => b.trim()));
  const validQs = questions.filter((q) => q.label.trim());
  const contact = (
    [
      // Meta renders the pre-defined contact questions in the form's locale (we mint PT_PT), so mirror
      // its Portuguese labels here — the API reads these back in English regardless of locale, which is
      // why the read-back can't be used to check what a lead actually sees.
      std.FULL_NAME && { label: "Nome completo", ph: "Nome completo" },
      std.EMAIL && { label: "Email", ph: "email@exemplo.com" },
      std.PHONE && { label: "Número de telemóvel", ph: "+351 900 000 000" },
    ].filter(Boolean) as { label: string; ph: string }[]
  );

  // Meta's real pagination: the intro card, then ONE screen per question, then contact info, then the
  // completion screen.
  const pages: Page[] = [
    ...(hasIntro ? [{ kind: "intro", label: "Intro" } as Page] : []),
    ...validQs.map((q, k) => ({ kind: "question", label: `Question ${k + 1}`, q }) as Page),
    ...(contact.length ? [{ kind: "contact", label: "Contact info" } as Page] : []),
    { kind: "completion", label: "Completion" } as Page,
  ];

  const [idx, setIdx] = useState(0);
  const i = Math.min(idx, pages.length - 1);
  const page = pages[i];
  const biz = pageName.trim() || "Your Page";

  return createPortal(
    <div className="fixed inset-0 z-[95] flex flex-col items-center justify-center gap-4 bg-black/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <button
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100"
      >
        <XIcon className="h-4 w-4" />
      </button>

      <div onMouseDown={(e) => e.stopPropagation()} className="flex flex-col items-center gap-4">
        {/* Phone frame */}
        <div className="w-[320px] overflow-hidden rounded-[2rem] border-[6px] border-neutral-800 bg-white shadow-2xl">
          <div className="flex h-6 items-center justify-center bg-neutral-100">
            <div className="h-1.5 w-16 rounded-full bg-neutral-300" />
          </div>
          {/* Page identity */}
          <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-500">{biz.slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-neutral-900">{biz}</div>
              <div className="text-[11px] text-neutral-400">Sponsored</div>
            </div>
          </div>

          {/* Screen content */}
          <div className="h-[440px] overflow-y-auto bg-white px-4 py-4 text-neutral-900">
            {page.kind === "intro" && (
              <div className="space-y-3">
                <div className="h-24 w-full rounded-lg bg-gradient-to-br from-neutral-200 to-neutral-100" />
                {greeting.headline.trim() && <h3 className="text-lg font-bold leading-snug">{greeting.headline}</h3>}
                {greeting.style === "list" ? (
                  <ul className="space-y-1.5">
                    {greeting.bullets.filter((b) => b.trim()).map((b, k) => (
                      <li key={k} className="flex gap-2 text-sm text-neutral-700"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" />{b}</li>
                    ))}
                  </ul>
                ) : (
                  greeting.paragraph.trim() && <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">{greeting.paragraph}</p>
                )}
              </div>
            )}

            {page.kind === "question" && (
              <div className="space-y-4">
                <h3 className="text-base font-semibold leading-snug text-neutral-900">{page.q.label}</h3>
                {page.q.kind === "mc" ? (
                  <div className="space-y-2">
                    {page.q.options.filter((o) => o.trim()).length === 0 ? (
                      <p className="text-xs text-neutral-400">No answers added yet.</p>
                    ) : (
                      page.q.options.filter((o) => o.trim()).map((o, j) => (
                        <div key={j} className="flex items-center gap-3 rounded-lg border border-neutral-300 px-3 py-3 text-sm text-neutral-800">
                          <span className="h-4 w-4 shrink-0 rounded-full border-2 border-neutral-400" />
                          {o}
                        </div>
                      ))
                    )}
                  </div>
                ) : page.q.kind === "appt" ? (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-neutral-300 px-3 py-3 text-sm text-neutral-400">📅 Select a preferred date</div>
                    <div className="rounded-lg border border-neutral-300 px-3 py-3 text-sm text-neutral-400">🕐 Select a preferred time</div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-neutral-300 px-3 py-3 text-sm text-neutral-400">Your answer</div>
                )}
              </div>
            )}

            {page.kind === "contact" && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-neutral-900">Contact information</h3>
                  <p className="mt-1 text-xs text-neutral-500">Please confirm your details — Meta fills these in from your profile.</p>
                </div>
                <div className="space-y-3">
                  {contact.map((c, k) => (
                    <div key={k} className="space-y-1">
                      <div className="text-xs text-neutral-500">{c.label}</div>
                      <div className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-400">{c.ph}</div>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-snug text-neutral-400">
                  Ao clicar em Enviar, concordas com a <span className="text-[#1877F2]">política de privacidade</span> de {biz} e os termos da Meta.
                </p>
              </div>
            )}

            {page.kind === "completion" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-600">✓</div>
                {thankYou.headline.trim() && <h3 className="text-lg font-bold text-neutral-900">{thankYou.headline}</h3>}
                {thankYou.message.trim() && <p className="text-sm text-neutral-600">{thankYou.message}</p>}
              </div>
            )}
          </div>

          {/* Bottom CTA — mirrors the real form's button on each screen */}
          <div className="border-t border-neutral-200 bg-white px-4 py-3">
            {page.kind === "completion" ? (
              thankYou.website.trim() || thankYou.button.trim() ? (
                <div className="w-full rounded-lg bg-[#1877F2] py-2.5 text-center text-sm font-semibold text-white">{thankYou.button.trim() || "Visitar o site"}</div>
              ) : (
                <div className="w-full rounded-lg bg-neutral-200 py-2.5 text-center text-sm font-semibold text-neutral-500">Concluído</div>
              )
            ) : (
              <div className="w-full rounded-lg bg-[#1877F2] py-2.5 text-center text-sm font-semibold text-white">{page.kind === "contact" ? "Enviar" : "Continuar"}</div>
            )}
          </div>
        </div>

        {/* Pager */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setIdx((n) => Math.max(0, n - 1))}
            disabled={i === 0}
            aria-label="Previous screen"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-700 text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 disabled:opacity-30"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            {pages.map((p, k) => (
              <button key={`${p.kind}-${k}`} onClick={() => setIdx(k)} aria-label={p.label} title={p.label} className={cn("h-2 w-2 rounded-full transition-colors", k === i ? "bg-accent" : "bg-neutral-600 hover:bg-neutral-500")} />
            ))}
          </div>
          <button
            onClick={() => setIdx((n) => Math.min(pages.length - 1, n + 1))}
            disabled={i === pages.length - 1}
            aria-label="Next screen"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-700 text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 disabled:opacity-30"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="text-xs font-medium text-neutral-400">{page.label} · {i + 1}/{pages.length}</div>
      </div>
    </div>,
    document.body
  );
}
