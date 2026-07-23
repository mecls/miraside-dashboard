import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { fetchContactNotes } from "@/lib/ghl";
import { ghlConfig, createContactNote, updateContactNote, deleteContactNote } from "@/lib/ghl-write";

export const runtime = "nodejs";
export const maxDuration = 30; // bound a hung GHL call so it can't hold the function to the platform limit

const MAX_NOTE_LEN = 5000;

/**
 * Contact notes live in GoHighLevel (native Notes — the source of truth, visible in GHL too). They're
 * fetched LAZILY when a lead row is expanded / its notes popup is opened, so they never bloat the
 * 30-min sync. Any authed user can read/add/edit/remove — taking call notes is the operator's job.
 *
 * leads.notes_count is a lightweight mirror JUST for the row's note chip (so we know a lead has notes
 * without opening it): incremented on add, decremented on delete, and reconciled to the true count on
 * every read. The 30-min sync also recounts every linked contact (lib/sync/leads.ts step 3b), so a note
 * written directly inside GHL lights the chip on its own within a cycle — these writes race it, hence
 * the compare-and-swap guard there.
 */
type CachedNote = { id: string; body: string; createdAt: string | null };
type Resolved = {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  id: string;
  contactId: string | null;
  notesCount: number;
  notesCache: CachedNote[];
};

async function resolveContact(params: Promise<{ id: string }>): Promise<Resolved | { error: NextResponse }> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return { error: NextResponse.json({ error: "No tenant configured." }, { status: 400 }) };
  const { id } = await params;
  if (!id) return { error: NextResponse.json({ error: "Missing lead id." }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: lead } = await admin.from("leads").select("id, ghl_contact_id, notes_count, notes_cache").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!lead) return { error: NextResponse.json({ error: "Lead not found." }, { status: 404 }) };
  return {
    admin,
    tenantId,
    id,
    contactId: (lead.ghl_contact_id as string | null) ?? null,
    notesCount: (lead.notes_count as number) ?? 0,
    notesCache: Array.isArray(lead.notes_cache) ? (lead.notes_cache as CachedNote[]) : [],
  };
}

/** Refresh the row's display cache of notes (newest first). Display-only, last-write-wins — GHL is the
 *  truth and every GET reconciles, so a lost race here costs at most one stale popup open. */
async function setCache(r: Resolved, notes: CachedNote[]) {
  await r.admin
    .from("leads")
    .update({ notes_cache: notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt ?? null })) })
    .eq("tenant_id", r.tenantId)
    .eq("id", r.id);
}

async function setCount(r: Resolved, n: number) {
  if (n === r.notesCount) return;
  const value = Math.max(0, n);
  const q = r.admin.from("leads").update({ notes_count: value }).eq("tenant_id", r.tenantId).eq("id", r.id);
  // Compare-and-swap on the count we read at request start (mirrors the sync's step-3b guard): if a
  // concurrent add/delete already moved it, no-op instead of clobbering their result with our stale value.
  // The next GET or the 30-min sync reconciles the chip either way.
  await (r.notesCount === 0 ? q.or("notes_count.is.null,notes_count.eq.0") : q.eq("notes_count", r.notesCount));
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolveContact(params);
  if ("error" in r) return r.error;
  // Not linked / GHL off → no notes yet, not an error.
  if (!ghlConfig() || !r.contactId) {
    await setCount(r, 0);
    return NextResponse.json({ notes: [] });
  }
  try {
    const notes = await fetchContactNotes(r.contactId);
    await setCount(r, notes.length); // reconcile the row-chip mirror to the truth
    await setCache(r, notes as CachedNote[]); // ...and the instant-open cache
    return NextResponse.json({ notes });
  } catch (e) {
    console.error("notes GET failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't load notes." }, { status: 502 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolveContact(params);
  if ("error" in r) return r.error;
  if (!ghlConfig() || !r.contactId) return NextResponse.json({ error: "This lead isn't linked to GoHighLevel." }, { status: 400 });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const text = String(body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "Note is empty." }, { status: 400 });
  if (text.length > MAX_NOTE_LEN) return NextResponse.json({ error: "Note is too long." }, { status: 400 });
  try {
    const note = await createContactNote(r.contactId, text);
    const count = Math.max(0, r.notesCount + 1);
    await setCount(r, count);
    await setCache(r, [note as CachedNote, ...r.notesCache]);
    // Return the authoritative post-write count: the client's Undo re-posts from a toast that has usually
    // already closed the notes popup (component unmounted), so it can't recompute the count locally.
    return NextResponse.json({ note, count });
  } catch (e) {
    console.error("notes POST failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't save the note." }, { status: 502 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolveContact(params);
  if ("error" in r) return r.error;
  if (!ghlConfig() || !r.contactId) return NextResponse.json({ error: "This lead isn't linked to GoHighLevel." }, { status: 400 });
  const noteId = new URL(req.url).searchParams.get("noteId");
  if (!noteId) return NextResponse.json({ error: "Missing note." }, { status: 400 });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const text = String(body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "Note is empty." }, { status: 400 });
  if (text.length > MAX_NOTE_LEN) return NextResponse.json({ error: "Note is too long." }, { status: 400 });
  try {
    const note = await updateContactNote(r.contactId, noteId, text);
    await setCache(r, r.notesCache.map((n) => (n.id === noteId ? { ...n, body: note.body } : n)));
    return NextResponse.json({ note });
  } catch (e) {
    console.error("notes PUT failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't update the note." }, { status: 502 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolveContact(params);
  if ("error" in r) return r.error;
  const noteId = new URL(req.url).searchParams.get("noteId");
  if (!ghlConfig() || !r.contactId || !noteId) return NextResponse.json({ error: "Missing note." }, { status: 400 });
  try {
    await deleteContactNote(r.contactId, noteId);
    await setCount(r, r.notesCount - 1);
    await setCache(r, r.notesCache.filter((n) => n.id !== noteId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("notes DELETE failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't delete the note." }, { status: 502 });
  }
}
