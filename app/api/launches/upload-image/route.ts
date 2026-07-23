import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadAdImage } from "@/lib/meta-ads";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Pre-upload ONE ad image to Meta. The browser uploads the file to Supabase Storage first (bypassing
 * Vercel's request-body limit), then calls this with the storage path; we hand the bytes to Meta and
 * return the image hash. This keeps the bulk-launch payload tiny (hashes, not base64) so any number of
 * ads can launch in a single request — no "too much media" ceiling.
 */
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const path = typeof body.path === "string" ? body.path : "";
  if (!path.startsWith("launch-images/")) return NextResponse.json({ error: "Bad path" }, { status: 400 });

  const admin = createAdminClient();
  const { data: blob, error } = await admin.storage.from("launch-media").download(path);
  if (error || !blob) return NextResponse.json({ error: "Image not found in storage" }, { status: 404 });

  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  try {
    const { hash } = await uploadAdImage(base64);
    return NextResponse.json({ hash });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Image upload failed" }, { status: 502 });
  } finally {
    await admin.storage.from("launch-media").remove([path]).catch(() => {});
  }
}
