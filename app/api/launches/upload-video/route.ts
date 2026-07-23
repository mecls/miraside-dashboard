import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadAdVideo } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Pre-upload a (possibly large) video to Meta. The browser uploads the file straight to Supabase
 * Storage first (bypassing Vercel's request-body limit), then calls this with the storage path; we
 * stream it to Meta (resumable for big files), delete the temp object, and return the video_id.
 */
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const path = typeof body.path === "string" ? body.path : "";
  if (!path.startsWith("videos/")) return NextResponse.json({ error: "Bad path" }, { status: 400 });

  const admin = createAdminClient();
  const { data: blob, error } = await admin.storage.from("launch-media").download(path);
  if (error || !blob) return NextResponse.json({ error: "Video not found in storage" }, { status: 404 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    const { id } = await uploadAdVideo(bytes, path.split("/").pop() || "video.mp4");
    return NextResponse.json({ videoId: id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Video upload failed" }, { status: 502 });
  } finally {
    await admin.storage.from("launch-media").remove([path]).catch(() => {});
  }
}
