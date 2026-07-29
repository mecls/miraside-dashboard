import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { mirrorCallState } from "@/lib/cold-calls-writeback";
import { fetchColdCallContact } from "@/lib/cold-calls-db";
import { CALL_STATUSES } from "@/lib/cold-calls";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_NOTE = 5000;
const MAX_NAME = 120;
const STATUS_SET = new Set<string>(CALL_STATUSES as readonly string[]);

/** Full record for the detail drawer — includes the long free-text columns the list omits. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing contact id." }, { status: 400 });

  try {
    const admin = createAdminClient();
    const contact = await fetchColdCallContact(admin, tenantId, id);
    if (!contact) return NextResponse.json({ ok: false, error: "Contact not found." }, { status: 404 });
    return NextResponse.json({ ok: true, contact });
  } catch (e) {
    console.error("GET /api/cold-calls read failed:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "Failed to load contact." }, { status: 500 });
  }
}

/**
 * Edit a contact's dashboard-owned call state (Call Status / Assigned User / Notes) and mirror it back to
 * the sheet. The DB is the source of truth: a failed sheet write-back does NOT fail the request — it's
 * reported so the UI can surface it, and self-heals on the next edit or sync.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing contact id." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has("callStatus") && !has("assignedUser") && !has("notes")) {
    return NextResponse.json({ ok: false, error: "Nothing to update." }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (has("callStatus")) {
    const v = String(body.callStatus ?? "").trim();
    if (!STATUS_SET.has(v)) return NextResponse.json({ ok: false, error: "Invalid call status." }, { status: 400 });
    patch.call_status = v;
  }
  if (has("assignedUser")) {
    const v = String(body.assignedUser ?? "").trim();
    if (v.length > MAX_NAME) return NextResponse.json({ ok: false, error: "Assignee name too long." }, { status: 400 });
    patch.assigned_user = v || null;
  }
  if (has("notes")) {
    const v = String(body.notes ?? "");
    if (v.length > MAX_NOTE) return NextResponse.json({ ok: false, error: "Notes too long." }, { status: 400 });
    patch.notes = v.trim() || null;
  }

  const admin = createAdminClient();
  const { data: c, error: readErr } = await admin
    .from("cold_call_contacts")
    .select("id, email, phone, person_linkedin, sheet_row, call_status, assigned_user, notes")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("PATCH /api/cold-calls read failed:", readErr.message);
    return NextResponse.json({ ok: false, error: "Failed to load contact." }, { status: 500 });
  }
  if (!c) return NextResponse.json({ ok: false, error: "Contact not found." }, { status: 404 });

  const { error: upErr } = await admin.from("cold_call_contacts").update(patch).eq("tenant_id", tenantId).eq("id", id);
  if (upErr) {
    console.error("PATCH /api/cold-calls update failed:", upErr.message);
    return NextResponse.json({ ok: false, error: "Failed to save." }, { status: 500 });
  }

  // Mirror the current call state back to the sheet (best-effort; never fails the request).
  const writeback = await mirrorCallState(admin, tenantId, id, {
    email: String(c.email ?? ""),
    phone: String(c.phone ?? ""),
    personLinkedin: String(c.person_linkedin ?? ""),
    sheetRow: (c.sheet_row as number) ?? null,
    callStatus: String(patch.call_status ?? c.call_status ?? "Not called"),
    assignedUser: String(patch.assigned_user ?? c.assigned_user ?? ""),
    notes: String(patch.notes ?? c.notes ?? ""),
  });

  return NextResponse.json({ ok: true, writeback });
}
