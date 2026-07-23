"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { ImageIcon, VideoIcon, CopyIcon, LayersIcon, CarouselIcon, PlusIcon, XIcon, ChevronDownIcon, SearchIcon, CheckIcon } from "../icons";
import { FORMAT_META } from "./constants";
import { Popover, CheckBox, TRIGGER_CLASS } from "./Select";
import type { AdFormat, AdStatus, UploadedCreative, AdSetGroup } from "../types";

const FORMAT_ICON: Record<AdFormat, (p: { className?: string }) => React.ReactElement> = {
  single: ImageIcon,
  multi_ratio: CopyIcon,
  flexible: LayersIcon,
  carousel: CarouselIcon,
};

export function FormatCell({ format }: { format: AdFormat }) {
  const Icon = FORMAT_ICON[format];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-200">
      <Icon className="h-3.5 w-3.5 text-neutral-400" />
      {FORMAT_META[format].label}
    </span>
  );
}

export function StatusCell({ status, onChange }: { status: AdStatus; onChange: (s: AdStatus) => void }) {
  const active = status === "ACTIVE";
  return (
    <button
      onClick={() => onChange(active ? "PAUSED" : "ACTIVE")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-emerald-400" : "bg-amber-400")} />
      {active ? "Active" : "Paused"}
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        on ? "bg-accent" : "bg-neutral-700"
      )}
    >
      <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform", on ? "translate-x-[19px]" : "translate-x-[3px]")} />
    </button>
  );
}

/** A textarea that starts at one line and grows only as far as its content needs. */
function AutoTextarea({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={className} />;
}

/** A clearly-visible selection checkbox (native ones vanish on the dark theme). Supports indeterminate. */
export function RowCheck({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  const lit = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "flex h-[18px] w-[18px] items-center justify-center rounded-[5px] ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        lit ? "bg-accent text-neutral-950 ring-accent" : "bg-neutral-800 text-transparent ring-neutral-600 hover:ring-neutral-400"
      )}
    >
      {indeterminate ? <span className="h-0.5 w-2.5 rounded-full bg-white" /> : <CheckIcon className={cn("h-3 w-3", checked ? "opacity-100" : "opacity-0")} />}
    </button>
  );
}

export function MediaCell({ creatives }: { creatives: UploadedCreative[] }) {
  const shown = creatives.slice(0, 3);
  return (
    <div className="flex">
      {shown.map((c, i) => (
        <div
          key={c.id}
          className={cn("h-9 w-9 overflow-hidden rounded-md ring-1 ring-inset ring-neutral-700", i > 0 && "-ml-2 ring-2 ring-offset-0")}
        >
          {c.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.previewUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-400">
              <VideoIcon className="h-4 w-4" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function TextCell({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 transition-colors hover:border-neutral-700 focus:border-neutral-500 focus:bg-surface-200 focus:outline-none focus:ring-2 focus:ring-accent/20"
    />
  );
}

/** Primary text / headline / description. Variations only when the format allows them. */
export function VariationCell({
  values,
  onChange,
  placeholder,
  allowVariations,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  allowVariations: boolean;
}) {
  const boxClass =
    "block w-full resize-none overflow-hidden rounded-md border border-neutral-700 bg-surface-200 px-2.5 py-1.5 text-sm leading-relaxed text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20";

  if (!allowVariations) {
    return <AutoTextarea value={values[0] ?? ""} onChange={(v) => onChange([v])} placeholder={placeholder} className={boxClass} />;
  }

  function setAt(i: number, v: string) {
    const next = [...values];
    next[i] = v;
    onChange(next);
  }
  function add() {
    if (values.length < 5) onChange([...values, ""]);
  }
  function remove(i: number) {
    if (values.length > 1) onChange(values.filter((_, j) => j !== i));
  }

  return (
    <div className="space-y-1.5">
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className="mt-1.5 text-xs text-neutral-600">{i + 1}.</span>
          <AutoTextarea value={v} onChange={(nv) => setAt(i, nv)} placeholder={placeholder} className={boxClass} />
          {values.length > 1 && (
            <button onClick={() => remove(i)} aria-label="Remove variation" className="mt-1.5 text-neutral-600 hover:text-rose-400 focus:outline-none focus-visible:text-rose-400">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      {values.length < 5 && (
        <button onClick={add} className="inline-flex items-center gap-1 text-xs text-neutral-500 transition-colors hover:text-accent focus:outline-none focus-visible:text-accent">
          <PlusIcon className="h-3 w-3" /> Add variation (<span className="tabular-nums">{values.length}/5</span>)
        </button>
      )}
    </div>
  );
}

/**
 * "Launch New" with 2+ audiences: pick which audience ad sets this ad launches into. Toggle chips;
 * an empty selection means "all audiences" (so every chip shows active). At least one stays selected.
 */
export function AudienceCell({
  audiences,
  value,
  onChange,
}: {
  audiences: { id: string; name: string; destination: "form" | "site" }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const allIds = audiences.map((a) => a.id);
  const active = value.length ? value : allIds; // empty = all
  function toggle(id: string) {
    const has = active.includes(id);
    const next = has ? active.filter((x) => x !== id) : [...active, id];
    if (next.length === 0) return; // never leave an ad with no audience
    onChange(next.length === allIds.length ? [] : next);
  }
  return (
    <div className="flex flex-wrap gap-1">
      {audiences.map((a) => {
        const on = active.includes(a.id);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => toggle(a.id)}
            title={`${a.name} · ${a.destination === "site" ? "Landing page" : "Instant form"}`}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
              on ? "border-accent/30 bg-accent/10 text-accent" : "border-neutral-700 text-neutral-500 hover:text-neutral-300"
            )}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.destination === "site" ? "bg-sky-400" : "bg-emerald-400", !on && "opacity-40")} />
            <span className="truncate">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Multi-select of existing ad sets, grouped by campaign. */
export function AdSetsCell({ value, onChange, tree }: { value: string[]; onChange: (ids: string[]) => void; tree: AdSetGroup[] }) {
  const [q, setQ] = useState("");
  const all = tree.flatMap((g) => g.adSets);
  const label =
    value.length === 0 ? "Select ad sets..." : value.length === 1 ? all.find((s) => s.id === value[0])?.name ?? "1 selected" : `${value.length} selected`;

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }

  return (
    <Popover
      width={300}
      align="right"
      trigger={({ toggle: t, ref }) => (
        <button ref={ref} type="button" onClick={t} className={cn(TRIGGER_CLASS, value.length ? "text-neutral-200" : "text-neutral-500")}>
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-neutral-500" />
        </button>
      )}
    >
      {() => {
        if (tree.length === 0) {
          return <div className="px-3 py-6 text-center text-xs text-neutral-600">Connect an ad account to load campaigns and ad sets.</div>;
        }
        return (
          <>
            <div className="sticky top-0 flex items-center gap-2 bg-neutral-900 px-2 py-1.5">
              <SearchIcon className="h-3.5 w-3.5 text-neutral-500" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search ad sets..."
                className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
              />
            </div>
            {tree.map((g) => {
              const sets = g.adSets.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
              if (sets.length === 0) return null;
              return (
                <div key={g.campaignId}>
                  <div className="mono-label truncate px-3 pb-0.5 pt-2">{g.campaignName}</div>
                  {sets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s.id)}
                      className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-neutral-200 hover:bg-[#2e2e2e]"
                    >
                      <CheckBox checked={value.includes(s.id)} />
                      <span className="truncate">{s.name}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </>
        );
      }}
    </Popover>
  );
}
