"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { cn } from "./ui";

// Grouped so the dropdown can show subtle separators (days / weeks / months / years).
const PRESETS = [
  { key: "7d", label: "Last 7 days", group: 0 },
  { key: "30d", label: "Last 30 days", group: 0 },
  { key: "90d", label: "Last 90 days", group: 0 },
  { key: "this_week", label: "This week", group: 1 },
  { key: "last_week", label: "Last week", group: 1 },
  { key: "this_month", label: "This month", group: 2 },
  { key: "last_month", label: "Last month", group: 2 },
  { key: "this_year", label: "This year", group: 3 },
  { key: "last_year", label: "Last year", group: 3 },
];
const LABELS: Record<string, string> = Object.fromEntries(PRESETS.map((p) => [p.key, p.label]));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (y: number, m1: number, d: number) => `${y}-${pad(m1)}-${pad(d)}`; // m1 = 1-based month
const toISO = (d: Date) => fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
const shortDate = (s: string | null) => {
  if (!s) return "";
  const [, m, d] = s.split("-");
  return m ? `${MONTHS[+m - 1]} ${+d}` : s;
};
function parseISO(s: string | null): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z"); // noon anchor -> DST-safe day arithmetic
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 — weeks start Monday (matches the weekly chart)
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// Presets are anchored on the ACCOUNT-LOCAL "today" (passed from the server), so they
// agree with the server's default range and Ads Manager — not the browser's UTC clock.
function rangeFor(key: string, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number); // m is 1-based
  const to = today;
  switch (key) {
    case "7d":
      return { from: addDaysStr(today, -6), to };
    case "90d":
      return { from: addDaysStr(today, -89), to };
    case "this_week":
      return { from: mondayOf(today), to }; // Monday → today (week-to-date)
    case "last_week": {
      const mo = mondayOf(today);
      return { from: addDaysStr(mo, -7), to: addDaysStr(mo, -1) }; // previous Mon → Sun
    }
    case "this_month":
      return { from: fmt(y, m, 1), to };
    case "last_month": {
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate(); // day 0 of next month = last day of lm
      return { from: fmt(ly, lm, 1), to: fmt(ly, lm, lastDay) };
    }
    case "this_year":
      return { from: fmt(y, 1, 1), to };
    case "last_year":
      return { from: fmt(y - 1, 1, 1), to: fmt(y - 1, 12, 31) };
    case "30d":
    default:
      return { from: addDaysStr(today, -29), to };
  }
}

export function RangePicker({ today }: { today?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const active = sp.get("preset") ?? "30d";
  // Fall back to the browser date only if the server didn't pass account-local today.
  const baseToday = today ?? new Date().toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [showCal, setShowCal] = useState(active === "custom");
  const [range, setRange] = useState<DateRange | undefined>(
    active === "custom" ? { from: parseISO(sp.get("from")), to: parseISO(sp.get("to")) } : undefined
  );

  const triggerLabel =
    active === "custom"
      ? sp.get("from") && sp.get("to")
        ? `${shortDate(sp.get("from"))} – ${shortDate(sp.get("to"))}`
        : "Custom range"
      : LABELS[active] ?? "Last 30 days";

  function go(params: Record<string, string>) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(params)) next.set(k, v);
    router.push(`${pathname}?${next.toString()}`);
  }
  function pickPreset(key: string) {
    const r = rangeFor(key, baseToday);
    setOpen(false);
    go({ preset: key, from: r.from, to: r.to });
  }
  function applyCustom() {
    if (range?.from && range?.to) {
      setOpen(false);
      go({ preset: "custom", from: toISO(range.from), to: toISO(range.to) });
    }
  }

  const item = (selected: boolean) =>
    cn(
      "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
      selected ? "bg-surface-200 text-neutral-100" : "text-neutral-300 hover:bg-surface-200 hover:text-neutral-100"
    );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none"
      >
        {triggerLabel}
        <svg
          className={cn("h-4 w-4 text-neutral-500 transition-transform", open && "rotate-180")}
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

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 min-w-[13rem] rounded-md border border-[#333333] bg-[#242424] p-1.5 shadow-lg">
            {PRESETS.map((p, i) => (
              <div key={p.key}>
                {i > 0 && PRESETS[i - 1].group !== p.group && <div className="my-1 border-t border-neutral-800/70" />}
                <button onClick={() => pickPreset(p.key)} className={item(active === p.key)}>
                  <span>{p.label}</span>
                  {active === p.key && <Check />}
                </button>
              </div>
            ))}
            <div className="my-1 border-t border-neutral-800/70" />
            <button onClick={() => setShowCal((s) => !s)} className={item(active === "custom")}>
              <span>Custom range…</span>
              {active === "custom" && <Check />}
            </button>
            {showCal && (
              <div className="mt-1 border-t border-neutral-800/70 px-1 pt-2">
                <DayPicker
                  mode="range"
                  numberOfMonths={1}
                  selected={range}
                  onSelect={setRange}
                  defaultMonth={range?.from ?? new Date()}
                  weekStartsOn={1}
                />
                <div className="flex items-center justify-between gap-3 border-t border-neutral-800 pt-2">
                  <span className="text-[11px] tabular-nums text-neutral-500">
                    {range?.from ? toISO(range.from) : "start"} → {range?.to ? toISO(range.to) : "end"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setRange(undefined)} className="text-[11px] text-neutral-500 hover:text-neutral-300">
                      Clear
                    </button>
                    <button
                      onClick={applyCustom}
                      disabled={!range?.from || !range?.to}
                      className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Check() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-neutral-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
