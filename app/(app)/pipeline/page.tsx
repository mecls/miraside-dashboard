import { PageHeader } from "@/components/ui";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { getPipelineBoard } from "@/lib/pipeline";
import { PipelineView } from "@/components/pipeline/PipelineView";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ pipeline?: string; view?: string }> }) {
  const { pipeline: pipelineParam } = await searchParams;
  const tenantId = await getPrimaryTenantId();
  const admin = createAdminClient();
  const board = tenantId
    ? await getPipelineBoard(admin, tenantId, pipelineParam)
    : { configured: false, pipelines: [], pipeline: null, deals: [] };

  return (
    <div className="mx-auto w-full px-3 pb-10 sm:px-6">
      <PageHeader title="Pipeline" subtitle="Mirrors your GoHighLevel sales pipeline" />
      <div className="mt-4 md:mt-6">
        <PipelineView board={board} />
      </div>
    </div>
  );
}
