import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { fetchColdCallActivities } from "@/lib/cold-calls-db";

export const runtime = "nodejs";

/** Call history for one contact (drawer timeline). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing contact id." }, { status: 400 });

  try {
    const activities = await fetchColdCallActivities(createAdminClient(), tenantId, id);
    return NextResponse.json({ activities });
  } catch (e) {
    console.error("cold-calls activities GET failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't load call history." }, { status: 502 });
  }
}
