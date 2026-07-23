"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui";
import { filesToCreatives } from "./ImportZone";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  XIcon,
  PlusIcon,
  ImageIcon,
  VideoIcon,
  CopyIcon,
  LayersIcon,
  CarouselIcon,
} from "./icons";
import { useBodyScrollLock } from "./useBodyScrollLock";
import type { UploadedCreative, AdFormat } from "./types";

const MAX_THUMBS = 5;

type Scenario = { format: AdFormat; title: string; desc: string; Icon: (p: { className?: string }) => React.ReactElement };

const SCENARIOS: Scenario[] = [
  { format: "multi_ratio", title: "Multi-Ratio", desc: "Same ad in different aspect ratios (1:1, 4:5, 9:16)", Icon: CopyIcon },
  { format: "flexible", title: "Flexible Ads", desc: "Group creatives into one ad, Meta optimizes", Icon: LayersIcon },
  { format: "carousel", title: "Carousel Ads", desc: "Swipeable cards, each with its own creative", Icon: CarouselIcon },
];

export function ChooseFormatModal({
  creatives,
  onClose,
  onAddMore,
  onContinue,
}: {
  creatives: UploadedCreative[];
  onClose: () => void;
  onAddMore: (creatives: UploadedCreative[]) => void;
  onContinue: (format: AdFormat) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(); // freeze the page behind this popup

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    // Move focus into the dialog on open so keyboard/AT users start inside it.
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pickMore(files: FileList | null) {
    if (!files) return;
    const { creatives: added } = filesToCreatives(files);
    if (added.length) onAddMore(added);
  }

  const n = creatives.length;
  const visible = creatives.slice(0, MAX_THUMBS);
  const extra = n - visible.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-[2px] sm:items-center md:left-60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-panel shadow-md focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-label="Choose ad format"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Back"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div className="flex-1">
            <h2 className="text-sm font-medium text-neutral-50">Choose Ad Format</h2>
            <p className="text-xs text-neutral-500">
              {n} creative{n === 1 ? "" : "s"} uploaded
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* selected media strip */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="min-w-0 flex-1">
              <div className="mono-label">Selected media</div>
              <div className="mt-0.5 text-sm text-neutral-300">
                {n} file{n === 1 ? "" : "s"} ready
              </div>
            </div>
            <div className="flex items-center gap-2">
              {visible.map((c) => (
                <Thumb key={c.id} creative={c} />
              ))}
              {extra > 0 && (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent/15 text-xs font-semibold text-accent ring-1 ring-inset ring-accent/30">
                  +{extra}
                </div>
              )}
              <button
                onClick={() => inputRef.current?.click()}
                className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-neutral-800 text-neutral-500 transition-colors hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="Add more creatives"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
                multiple
                className="hidden"
                onChange={(e) => {
                  pickMore(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          {/* single image/video — primary */}
          <button
            onClick={() => onContinue("single")}
            className="group flex w-full items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-left transition-colors hover:border-accent hover:bg-surface-200/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300">
              <ImageIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-neutral-100">Single Image/Video Ads</div>
              <div className="mt-0.5 text-xs text-neutral-500">
                Each creative becomes its own ad. The standard ad format that works for most campaigns.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <div className="hidden items-center gap-1.5 sm:flex">
                <span className="h-6 w-6 rounded bg-neutral-800" />
                <span className="h-6 w-6 rounded bg-neutral-800" />
                <span className="h-6 w-6 rounded bg-neutral-800" />
                <span className="ml-1 whitespace-nowrap text-xs font-medium text-neutral-400">
                  = {n} Ad{n === 1 ? "" : "s"}
                </span>
              </div>
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 bg-neutral-700/30 text-neutral-400 transition-colors group-hover:border-neutral-600 group-hover:text-neutral-100">
                <ArrowRightIcon className="h-4 w-4" />
              </span>
            </div>
          </button>

          {/* special scenarios */}
          <div>
            <div className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-neutral-800" />
              <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-600">Special scenarios</span>
              <div className="h-px flex-1 bg-neutral-800" />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {SCENARIOS.map((s) => (
                <button
                  key={s.format}
                  onClick={() => onContinue(s.format)}
                  className="group rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-left transition-colors hover:border-accent hover:bg-surface-200/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300 transition-colors group-hover:text-accent">
                    <s.Icon className="h-4 w-4" />
                  </span>
                  <div className="mt-3 text-sm font-semibold text-neutral-100">{s.title}</div>
                  <div className="mt-1 text-xs text-neutral-500">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Thumb({ creative }: { creative: UploadedCreative }) {
  return (
    <div className="relative h-12 w-12 overflow-hidden rounded-lg ring-1 ring-inset ring-neutral-700">
      {creative.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={creative.previewUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-400">
          <VideoIcon className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
