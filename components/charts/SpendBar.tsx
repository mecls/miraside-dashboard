"use client";

import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

type Pt = { date: string; spend: number; partial?: boolean };

const SOLID = "#3ECF8E";
const PARTIAL = "#3ECF8E55"; // current (incomplete) day — faded so it doesn't read as a finished day

export function SpendBar({ data }: { data: Pt[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2e2e2e" vertical={false} />
        <XAxis dataKey="date" stroke="#707070" tick={{ fontSize: 11 }} tickMargin={8} tickFormatter={(d) => String(d).slice(5)} />
        <YAxis stroke="#707070" tick={{ fontSize: 11 }} />
        {/* Tooltip styled identically to the weekly-leads chart (LeadsLine) — same box. */}
        <Tooltip
          cursor={{ fill: "#ffffff08" }}
          contentStyle={{ background: "#171717", border: "1px solid #2e2e2e", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#a3a3a3" }}
          itemStyle={{ color: SOLID }} // bars are colored via <Cell>, so set the tooltip value color explicitly (else it renders near-black)
          formatter={(v: number, _n, p: any) => [`€${Number(v).toFixed(2)}${p?.payload?.partial ? " (so far today)" : ""}`, "spend"]}
        />
        <Bar dataKey="spend" radius={[3, 3, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.date} fill={d.partial ? PARTIAL : SOLID} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
