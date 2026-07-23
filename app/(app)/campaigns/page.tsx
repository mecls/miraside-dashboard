import { Suspense } from "react";
import { getDashboard } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import { RangePicker } from "@/components/RangePicker";
import { AdsManagerView } from "@/components/AdsManagerView";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const d = await getDashboard({ from: sp.from, to: sp.to });

  return (
    <div className="mx-auto max-w-6xl px-6 pb-10">
      <PageHeader
        title="Ads Manager"
        right={
          <Suspense fallback={null}>
            <RangePicker today={d.accountToday} />
          </Suspense>
        }
      />

      <div className="mt-6">
        {d.campaigns.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-800 p-6 text-sm text-neutral-600">
            No campaigns yet.
          </p>
        ) : (
          <AdsManagerView
            campaigns={d.campaigns}
            adsets={d.adsets}
            ads={d.ads}
            spendGate={d.spendGate}
            targetCpl={d.targetCpl}
            minResults={d.minResults}
            windowDays={d.reachWindowDays}
            fbAccountId={d.account?.fb_account_id ?? ""}
          />
        )}
      </div>
    </div>
  );
}
