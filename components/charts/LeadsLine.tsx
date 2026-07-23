"use client";

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-06-15" (the week's Monday) → "Jun 15"
const fmtWeek = (s: string) => {
  const parts = String(s).split("-");
  return parts.length === 3 ? `${MONTHS[+parts[1] - 1] ?? ""} ${+parts[2]}` : String(s);
};

export function LeadsLine({ data }: { data: { week: string; leads: number; partial?: boolean }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2e2e2e" vertical={false} />
        <XAxis dataKey="week" stroke="#707070" tick={{ fontSize: 11 }} tickMargin={8} tickFormatter={fmtWeek} />
        <YAxis stroke="#707070" tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: "#171717", border: "1px solid #2e2e2e", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#a3a3a3" }}
          itemStyle={{ color: "#3ECF8E" }}
          labelFormatter={(w) => `Week of ${fmtWeek(String(w))}`}
          formatter={(v: number, _n, p: any) => [`${v}${p?.payload?.partial ? " (in progress)" : ""}`, "leads"]}
        />
        <Line
          type="monotone"
          dataKey="leads"
          stroke="#3ECF8E"
          strokeWidth={2}
          // The in-progress (partial) current week gets a hollow dot so it doesn't read as a real dip.
          dot={(props: any) => {
            const partial = props?.payload?.partial;
            return (
              <circle
                key={props.key ?? `${props.cx}-${props.cy}`}
                cx={props.cx}
                cy={props.cy}
                r={3.5}
                fill={partial ? "#1f1f1f" : "#3ECF8E"}
                stroke="#3ECF8E"
                strokeWidth={partial ? 2 : 0}
              />
            );
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
