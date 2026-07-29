import { PageHeader } from "@/components/ui";
import { ColdCallsView } from "@/components/cold-calls/ColdCallsView";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { fetchColdCallRows, fetchColdCallsSyncedAt } from "@/lib/cold-calls-db";
import { COLD_CALLS_TAB, type ColdCallRow } from "@/lib/cold-calls";

export const dynamic = "force-dynamic";

export default async function ColdCallsPage() {
  const tenantId = await getPrimaryTenantId();

  let rows: ColdCallRow[] = [];
  let syncedAt: string | null = null;
  let error: string | null = null;

  if (!tenantId) {
    error = "No tenant configured.";
  } else {
    try {
      const admin = createAdminClient();
      [rows, syncedAt] = await Promise.all([fetchColdCallRows(admin, tenantId), fetchColdCallsSyncedAt(admin, tenantId)]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-6 pb-16">
      <PageHeader title="Cold Calls" subtitle={error ? "Google Sheet CRM" : `${COLD_CALLS_TAB} · ${rows.length.toLocaleString()} contacts`} />
      {error ? (
        <div className="mt-8 rounded-lg border border-dashed border-rose-500/30 bg-rose-500/5 p-6 text-sm">
          <div className="font-medium text-rose-300">Couldn&apos;t load Cold Calls</div>
          <p className="mt-1 max-w-2xl text-neutral-400">
            Reads from the <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">cold_call_contacts</code> table. If it&apos;s
            empty, run the migration then use “Sync now”.
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-neutral-950 p-3 text-xs text-neutral-500">{error}</pre>
        </div>
      ) : (
        <ColdCallsView contacts={rows} syncedAt={syncedAt} />
      )}
    </div>
  );
}
