"use client";

import { ResponsiveContainer, LineChart, Line, YAxis } from "recharts";

export function Sparkline({
  data,
  dataKey = "spend",
  color = "#3ECF8E",
}: {
  data: any[];
  dataKey?: string;
  color?: string;
}) {
  if (!data || data.length === 0) {
    return <div className="flex h-12 items-center text-xs text-neutral-700">no daily data</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <YAxis hide domain={["auto", "auto"]} />
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
