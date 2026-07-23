"use client";

import { useMemo, useState } from "react";
import { eur, int } from "@/lib/format";

/**
 * Donut breakdown with the "focus" hover pattern: resting state shows the total in the hole; hovering a
 * slice (or its legend row) dims every other slice, swaps the hole to that slice's value + share + name,
 * and highlights the matching legend row. Pure SVG — stroke-drawn arcs, no chart library.
 */

export interface SourceSlice {
  key: string;
  label: string;
  count: number;
}

/** Stable colour per source bucket — matches the app's semantic hues (brand green for paid,
 *  sky = calls, violet/amber/blue for the other outbound channels, neutral for unattributed). */
const SLICE_COLORS: Record<string, string> = {
  ads: "#3ECF8E",
  cold_call: "#38BDF8",
  cold_email: "#F59E0B",
  organic: "#A78BFA",
  linkedin_dm: "#60A5FA",
  direct: "#737373",
};
const FALLBACK_COLOR = "#525252";

const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

/** Centreline arc path from a0→a1 degrees (drawn as a thick stroke). */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
}

export function SourceDonut({ data, empty, format = "count" }: { data: SourceSlice[]; empty: string; format?: "count" | "eur" }) {
  const [hovered, setHovered] = useState<string | null>(null);
  // String prop, not a function: this is a client component fed by a server page, and functions can't
  // cross that boundary. "eur" renders values as € (the revenue donut); "count" as plain integers.
  const fmt = format === "eur" ? (n: number) => eur(n, 0) : (n: number) => int(n);

  // Largest slice first, clockwise from 12 o'clock — the long tail gathers back at the top.
  const slices = useMemo(() => {
    const nonZero = data.filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
    const total = nonZero.reduce((s, x) => s + x.count, 0);
    let angle = -90;
    return {
      total,
      items: nonZero.map((s) => {
        const sweep = total > 0 ? (s.count / total) * 360 : 0;
        const item = {
          ...s,
          pct: total > 0 ? (s.count / total) * 100 : 0,
          start: angle,
          end: angle + sweep,
          color: SLICE_COLORS[s.key] ?? FALLBACK_COLOR,
        };
        angle += sweep;
        return item;
      }),
    };
  }, [data]);

  // Zero state renders the REAL shape, not a placeholder sentence (Miguel, 2026-07-23): a neutral
  // track ring, 0 in the hole, and the full source legend dimmed at 0 · 0% — so the card reads the
  // same way it will once data lands.
  if (slices.total === 0) {
    return (
      <div>
        <div className="relative mx-auto h-[200px] w-[200px]">
          <svg viewBox="0 0 200 200" className="h-full w-full">
            <circle cx={100} cy={100} r={78} fill="none" stroke="#262626" strokeWidth={24} />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <div className={`${format === "eur" ? "text-2xl" : "text-3xl"} font-medium tabular-nums text-neutral-600`}>{fmt(0)}</div>
            <div className="mono-label mt-0.5">total</div>
          </div>
        </div>
        <div className="mt-4">
          {data.map((s) => (
            <div key={s.key} className="flex items-center gap-2.5 rounded px-2 py-1.5 text-sm opacity-60">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SLICE_COLORS[s.key] ?? FALLBACK_COLOR }} />
              <span className="min-w-0 flex-1 truncate text-neutral-400">{s.label}</span>
              <span className="tabular-nums font-medium text-neutral-500">{fmt(0)}</span>
              <span className="w-10 text-right tabular-nums text-neutral-600">0%</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const active = hovered ? slices.items.find((s) => s.key === hovered) ?? null : null;
  const C = 100; // viewBox centre
  const R = 78; // arc centreline radius
  const W = 24; // ring thickness
  const single = slices.items.length === 1;

  return (
    <div>
      {/* Donut + centre readout */}
      <div className="relative mx-auto h-[200px] w-[200px]" onMouseLeave={() => setHovered(null)}>
        <svg viewBox="0 0 200 200" className="h-full w-full">
          {single ? (
            <circle
              cx={C}
              cy={C}
              r={R}
              fill="none"
              stroke={slices.items[0].color}
              strokeWidth={hovered === slices.items[0].key ? W + 8 : W}
              className="cursor-pointer transition-all duration-150"
              onMouseEnter={() => setHovered(slices.items[0].key)}
            >
              <title>{`${slices.items[0].label}: ${fmt(slices.items[0].count)}`}</title>
            </circle>
          ) : (
            slices.items.map((s) => {
              // Hairline gap between slices; shrinks on thin slices so nothing vanishes.
              const pad = Math.min(1.1, (s.end - s.start) * 0.12);
              const isActive = hovered === s.key;
              return (
                <path
                  key={s.key}
                  d={arcPath(C, C, R, s.start + pad, s.end - pad)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={isActive ? W + 8 : W}
                  opacity={hovered && !isActive ? 0.22 : 1}
                  className="cursor-pointer transition-all duration-150"
                  onMouseEnter={() => setHovered(s.key)}
                >
                  <title>{`${s.label}: ${fmt(s.count)}`}</title>
                </path>
              );
            })
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {active ? (
            <>
              <div className={`${format === "eur" ? "text-2xl" : "text-3xl"} font-medium tabular-nums`} style={{ color: active.color }}>
                {fmt(active.count)}
              </div>
              <div className="text-sm tabular-nums" style={{ color: active.color }}>
                {Math.round(active.pct)}%
              </div>
              <div className="max-w-[110px] truncate text-xs text-neutral-500">{active.label}</div>
            </>
          ) : (
            <>
              <div className={`${format === "eur" ? "text-2xl" : "text-3xl"} font-medium tabular-nums text-neutral-50`}>{fmt(slices.total)}</div>
              <div className="mono-label mt-0.5">total</div>
            </>
          )}
        </div>
      </div>

      {/* Legend — hovering a row focuses its slice, and vice versa */}
      <div className="mt-4" onMouseLeave={() => setHovered(null)}>
        {slices.items.map((s) => {
          const isActive = hovered === s.key;
          return (
            <div
              key={s.key}
              className={`flex items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors duration-100 ${
                isActive ? "bg-neutral-800/70" : ""
              } ${hovered && !isActive ? "opacity-40" : ""}`}
              onMouseEnter={() => setHovered(s.key)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-neutral-200">{s.label}</span>
              <span className="tabular-nums font-medium text-neutral-50">{fmt(s.count)}</span>
              <span className="w-10 text-right tabular-nums text-neutral-500">{Math.round(s.pct)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
