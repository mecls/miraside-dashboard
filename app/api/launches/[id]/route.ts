import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

/**
 * Load a saved draft's full state (table rows + creative manifest) so the launcher can reopen it.
 * With `?images=1`, also returns the preview images for the History popup: fresh signed URLs for a
 * draft's creatives (the bucket is private), or the launch's stored thumbnails once it has launched
 * (its source media is cleaned up post-launch). The full set lives here rather than in the History
 * list payload, which only carries the 3 thumbs its rows render.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ad_launches")
    .select("draft_state, thumb_urls")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Launch not found" }, { status: 404 });

  const draft = (data.draft_state ?? null) as any;
  let images: { name: string; url: string }[] | undefined;
  if (new URL(req.url).searchParams.get("images")) {
    images = [];
    const creatives = Array.isArray(draft?.creatives) ? draft.creatives : [];
    for (const c of creatives) {
      if (c?.kind === "image" && typeof c?.path === "string") {
        const { data: signed } = await admin.storage.from("launch-media").createSignedUrl(c.path, 60 * 60);
        if (signed?.signedUrl) images.push({ name: c.name || "Ad", url: signed.signedUrl });
      }
    }
    // Already launched (no draft media left) → fall back to the stored thumbnails.
    if (!images.length) {
      images = ((data.thumb_urls ?? []) as string[]).map((url, i) => ({ name: `Ad ${i + 1}`, url }));
    }
  }
  return NextResponse.json({ draftState: draft, images });
}

/** Delete a Launch History entry (the record only — it never touches the live ads on Meta).
 * For a draft, also removes its saved creatives from Storage so nothing is orphaned. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row } = await admin.from("ad_launches").select("status, draft_state").eq("id", id).eq("tenant_id", tenantId).maybeSingle();

  // Clean up a draft's stored media (best-effort).
  const creatives = (row as any)?.draft_state?.creatives;
  if ((row as any)?.status === "DRAFT" && Array.isArray(creatives) && creatives.length) {
    const paths = creatives.map((c: any) => c?.path).filter((p: any): p is string => typeof p === "string");
    if (paths.length) await admin.storage.from("launch-media").remove(paths).catch(() => {});
  }

  const { error: delErr } = await admin.from("ad_launches").delete().eq("id", id).eq("tenant_id", tenantId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
