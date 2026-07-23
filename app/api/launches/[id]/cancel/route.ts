import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

/**
 * Cancel an in-progress (batched) launch. We clear the `pending` batch queue so the self-chaining processor
 * stops: it re-checks status + pending after its wait and aborts when the queue is gone. This NEVER touches
 * ads already created on Meta — those stay PAUSED. The record lands in a sensible resting state:
 *  - some ads already created  → PARTIAL (keeps the created count, notes the cancel)
 *  - nothing created + a draft   → back to a reopenable DRAFT (relaunch when ready)
 *  - nothing created, no draft    → CANCELLED
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("ad_launches")
    .select("status, ad_count, draft_state, pending")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only an in-flight launch can be cancelled. A finished/terminal record is a no-op — never flip a
  // completed PAUSED launch to PARTIAL with a bogus "cancelled" message (C13).
  if ((row as any).status !== "LAUNCHING") {
    return NextResponse.json({ ok: true, status: (row as any).status, noop: true });
  }

  // Free the queued (not-yet-launched) rows' images so a cancel doesn't orphan them in storage (C18).
  const pendingRows: any[] = Array.isArray((row as any).pending?.rows) ? (row as any).pending.rows : [];
  const orphanPaths = Array.from(
    new Set(pendingRows.flatMap((r) => (Array.isArray(r.imagePaths) ? r.imagePaths : [])).filter((p: any): p is string => typeof p === "string" && !!p))
  );
  if (orphanPaths.length) await admin.storage.from("launch-media").remove(orphanPaths).then(() => {}, () => {});

  const adCount = (row as any).ad_count || 0;
  const hasDraft = !!(row as any).draft_state;

  // Clearing `pending` is what actually stops the runner (the processor bails when it finds no queue).
  const update: Record<string, unknown> = { pending: null };
  if (adCount > 0) {
    update.status = "PARTIAL";
    update.last_error = `Launch cancelled — ${adCount} ad${adCount === 1 ? "" : "s"} already created (paused). The rest were stopped.`;
  } else if (hasDraft) {
    update.status = "DRAFT";
    update.last_error = null;
    update.total_ads = null;
  } else {
    update.status = "CANCELLED";
    update.last_error = "Launch cancelled before any ads were created.";
    update.total_ads = null;
  }

  // Guard on status so a batch that completed between our read and write isn't clobbered.
  const { error } = await admin.from("ad_launches").update(update).eq("id", id).eq("tenant_id", tenantId).eq("status", "LAUNCHING");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, status: update.status });
}
