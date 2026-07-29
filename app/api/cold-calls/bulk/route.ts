import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { batchWriteBack, type BatchPatch } from "@/lib/cold-calls-writeback";
import { CALL_STATUSES } from "@/lib/cold-calls";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_NAME = 120;
const MAX_IDS = 2000;
const STATUS_SET = new Set<string>(CALL_STATUSES as readonly string[]);

/**
 * Apply one call-state field (Call Status and/or Assigned User) to many contacts at once and mirror the
 * change back to the sheet in a single batched write. Same auth/validation contract as the single PATCH;
 * the DB is the source of truth, so a failed sheet write-back is reported (per-contact) but never fails
 * the request. An empty assignedUser clears the assignment (unassign).
 */
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).filter(Boolean))];
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "No contacts selected." }, { status: 400 });
  if (ids.length > MAX_IDS)
    return NextResponse.json({ ok: false, error: `Too many contacts selected (max ${MAX_IDS}).` }, { status: 400 });

  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const patch: Record<string, unknown> = {};
  const wb: BatchPatch = {};
  if (has("callStatus")) {
    const v = String(body.callStatus ?? "").trim();
    if (!STATUS_SET.has(v)) return NextResponse.json({ ok: false, error: "Invalid call status." }, { status: 400 });
    patch.call_status = v;
    wb.callStatus = v;
  }
  if (has("assignedUser")) {
    const v = String(body.assignedUser ?? "").trim();
    if (v.length > MAX_NAME) return NextResponse.json({ ok: false, error: "Assignee name too long." }, { status: 400 });
    patch.assigned_user = v || null;
    wb.assignedUser = v;
  }
  if (Object.keys(patch).length === 0)
    return NextResponse.json({ ok: false, error: "Nothing to update." }, { status: 400 });

  const admin = createAdminClient();

  // 1. Update the DB in one shot per chunk (source of truth).
  let updated = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const { error, count } = await admin
      .from("cold_call_contacts")
      .update(patch, { count: "exact" })
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + 200));
    if (error) {
      console.error("POST /api/cold-calls/bulk update failed:", error.message);
      return NextResponse.json({ ok: false, error: "Failed to save." }, { status: 500 });
    }
    updated += count ?? 0;
  }

  // 2. Mirror to the sheet in a single batched write (best-effort; never fails the request).
  const writeback = await batchWriteBack(admin, tenantId, ids, wb);

  return NextResponse.json({ ok: true, updated, writeback });
}
