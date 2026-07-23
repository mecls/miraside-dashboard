import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { isAdminEmail, isAdminUser } from "@/lib/admin";

export const runtime = "nodejs";

/**
 * Team management — add / remove dashboard logins and set roles (admin | user).
 * ADMIN-ONLY: only admins may manage the team (a "user" must never be able to escalate).
 * Admins can't be deleted (demote to user first); the bootstrap admin email can't be demoted at all.
 * Creating/deleting/updating auth users requires the service-role admin client.
 */
async function currentUser() {
  const supa = await createServerSupabase();
  const {
    data: { user },
  } = await supa.auth.getUser();
  return user;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  const me = await currentUser();
  if (!isAdminUser(me)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

  const admin = createAdminClient();
  // New people start as "user"; an admin can promote them afterwards.
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "user" } });
  if (error) {
    return NextResponse.json({ error: error.message || "Could not add this person." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

/** Promote/demote a user between admin and user. */
export async function PATCH(req: Request) {
  const me = await currentUser();
  if (!isAdminUser(me)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { id?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : null;
  if (!id || !role) return NextResponse.json({ error: "Missing id or role" }, { status: 400 });

  const admin = createAdminClient();
  const { data: target } = await admin.auth.admin.getUserById(id);
  if (!target?.user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // The bootstrap admin email is always admin — can't be demoted.
  if (role === "user" && isAdminEmail(target.user.email)) {
    return NextResponse.json({ error: "This account is the protected admin and can't be changed." }, { status: 400 });
  }
  const { error } = await admin.auth.admin.updateUserById(id, { app_metadata: { ...(target.user.app_metadata ?? {}), role } });
  if (error) return NextResponse.json({ error: error.message || "Could not update the role." }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const me = await currentUser();
  if (!isAdminUser(me)) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  if (id === me!.id) return NextResponse.json({ error: "You can't remove your own account." }, { status: 400 });

  const admin = createAdminClient();
  // Admins can't be removed — demote them to "user" first.
  const { data: target } = await admin.auth.admin.getUserById(id);
  if (isAdminUser(target?.user)) {
    return NextResponse.json({ error: "Admins can't be removed — change them to a user first." }, { status: 400 });
  }
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message || "Could not remove this person." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
