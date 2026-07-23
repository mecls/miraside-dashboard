import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { uploadAdImage, generateAdPreview } from "@/lib/meta-ads";
import { pageId } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 60;

const PREVIEW_LINK = "https://miraside.co"; // placeholder link for the feed preview (the lead form opens on click)

async function authed() {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  return !!user;
}

export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }

  const message = String(b.message ?? "").trim() || "Your ad text appears here";
  if (!b.imageHash && (typeof b.imageBase64 !== "string" || !b.imageBase64)) {
    return NextResponse.json({ ok: false, error: "Add an image to preview." }, { status: 400 });
  }

  try {
    // Reuse an already-uploaded image hash (from a prior preview) to avoid re-uploading.
    let hash = String(b.imageHash || "");
    if (!hash) hash = (await uploadAdImage(b.imageBase64.replace(/^data:image\/[a-z+]+;base64,/i, ""))).hash;

    const link_data: Record<string, any> = {
      image_hash: hash,
      message,
      link: PREVIEW_LINK,
      call_to_action: { type: b.callToAction || "LEARN_MORE", value: { link: PREVIEW_LINK } },
    };
    if (b.headline) link_data.name = String(b.headline);

    const spec: Record<string, any> = { object_story_spec: { page_id: pageId(), link_data } };
    const previews = await generateAdPreview(spec);
    if (!previews.length) return NextResponse.json({ ok: false, error: "Meta could not render a preview." }, { status: 502 });

    return NextResponse.json({ ok: true, imageHash: hash, previews });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Could not generate a preview." }, { status: 502 });
  }
}
