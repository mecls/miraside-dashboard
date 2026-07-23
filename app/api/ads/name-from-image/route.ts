import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Auto-name an ad from its creative image: a fast vision model reads the main text/headline in the
 * image and returns a short, descriptive ad name (1–5 words). Best-effort — on any failure it returns
 * an empty name and the launcher keeps the filename. Auth-gated; no data is stored.
 */
const PROMPT =
  "This is an advertising creative image. Reply with a SHORT, descriptive ad name of 1 to 5 words from its main headline/text, capitalized like a title, in the SAME language as the ad's own text (Portuguese text → a Portuguese name, English → English). NEVER translate. If there's no readable text, name it from what the image shows. No quotes, no trailing punctuation, no explanation — reply with ONLY the name.";

/** Tidy the model output into a clean short name. */
function clean(raw: string): string {
  let s = (raw || "").trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.!?,;:]+$/g, "").trim();
  // Guard against the model returning a sentence: cap at 6 words / 60 chars.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 6) s = words.slice(0, 6).join(" ");
  return s.slice(0, 60).trim();
}

export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ name: "" }); }
  const data = String(b.imageBase64 ?? "").replace(/^data:image\/[a-z+]+;base64,/i, "");
  const mediaType = /^image\/(jpeg|png|gif|webp)$/.test(b.mediaType) ? b.mediaType : "image/jpeg";
  if (!data) return NextResponse.json({ name: "" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return NextResponse.json({ name: "" }); // graceful: no key → keep the filename

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 48,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    const j: any = await res.json();
    if (j?.error) {
      console.error("[name-from-image] anthropic error", j.error?.message);
      return NextResponse.json({ name: "" });
    }
    const text = Array.isArray(j?.content) ? j.content.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ") : "";
    return NextResponse.json({ name: clean(text) });
  } catch (e: any) {
    console.error("[name-from-image] failed", e?.message ?? String(e));
    return NextResponse.json({ name: "" });
  }
}
