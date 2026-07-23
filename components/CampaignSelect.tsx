"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CampaignSummary } from "@/lib/queries";
import { AppSelect } from "@/components/AppSelect";

export function CampaignSelect({ campaigns, selected }: { campaigns: CampaignSummary[]; selected: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function go(id: string) {
    const next = new URLSearchParams(sp.toString());
    next.set("campaign", id);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <AppSelect
      value={selected}
      onChange={go}
      className="max-w-[340px] font-medium"
      options={campaigns.map((c) => ({ value: c.id, label: `${c.name} — ${c.adCount} ads` }))}
    />
  );
}
