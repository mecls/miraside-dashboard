import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// This endpoint only ever records a DRAFT (launches go LAUNCHING via /api/launches/create). PENDING was
// accepted but never sent or consumed by the state machine — dropped as dead config (C20).
const ALLOWED_STATUS = new Set(["DRAFT"]);

// Records a launch (a draft, for now) in ad_launches so it shows up in Launch History.
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Launch";
  const status = typeof body.status === "string" && ALLOWED_STATUS.has(body.status) ? body.status : "DRAFT";
  const format = typeof body.format === "string" ? body.format : null;
  const adCount = typeof body.adCount === "number" && Number.isFinite(body.adCount) ? Math.max(0, Math.floor(body.adCount)) : 0;
  const draftState = body.draftState && typeof body.draftState === "object" ? body.draftState : null;
  const thumbUrls = Array.isArray(body.thumbUrls) ? body.thumbUrls.filter((u: unknown) => typeof u === "string").slice(0, 3) : [];
  const id = typeof body.id === "string" && body.id ? body.id : null;

  const admin = createAdminClient();
  const fields = { name, status, format, ad_count: adCount, draft_state: draftState, thumb_urls: thumbUrls };
  // Re-saving a resumed draft updates it in place (no duplicate rows); a fresh draft inserts.
  if (id) {
    const { error } = await admin.from("ad_launches").update(fields).eq("id", id).eq("tenant_id", tenantId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id });
  }
  const { data, error } = await admin.from("ad_launches").insert({ tenant_id: tenantId, ...fields }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
