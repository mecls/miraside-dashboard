import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaGet, adAccountId } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Load existing ads' editable content so the launcher can open them in the Ad Setup grid
 * (pre-filled), where the user tweaks anything and then launches fresh PAUSED ads.
 *
 * For each ad we return name + primary text/headline/description + link + CTA + lead form + its
 * current ad set, plus the creative IMAGE downloaded as a data URL (so the grid can preview it and
 * re-upload it on launch). Image creatives only — videos / unsupported creatives are reported in `skipped`.
 */

const FB_ME = "http://fb.me/";

// The CTAs the launcher's dropdown offers (mirror of adsetup/constants.ts CTA_OPTIONS). A duplicated
// ad whose CTA isn't one of these is clamped to a sensible known value so the dropdown isn't blank.
const KNOWN_CTAS = new Set(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE", "DOWNLOAD", "GET_QUOTE", "GET_OFFER", "APPLY_NOW", "CONTACT_US"]);

/** Pull editable copy + the best full-res image URL out of a creative (link_data or asset_feed_spec). */
function parseCreative(creative: any): {
  message: string;
  headline: string;
  description: string;
  link: string | null;
  cta: string;
  leadFormId: string | null;
  imageUrl: string | null;
  imageHash: string | null;
} {
  const c = creative ?? {};
  const ld = c.object_story_spec?.link_data ?? {};
  const afs = c.asset_feed_spec ?? {};
  let leadFormId: string | null = ld.call_to_action?.value?.lead_gen_form_id ?? null;
  if (!leadFormId && Array.isArray(afs.call_to_actions)) {
    for (const a of afs.call_to_actions) {
      if (a?.value?.lead_gen_form_id) { leadFormId = String(a.value.lead_gen_form_id); break; }
    }
  }
  const link = ld.link ?? afs.link_urls?.[0]?.website_url ?? null;
  const imageHash = ld.image_hash ?? afs.images?.[0]?.hash ?? c.image_hash ?? null;
  const imageUrl = c.image_url ?? ld.picture ?? afs.images?.[0]?.url ?? c.thumbnail_url ?? null;
  return {
    message: ld.message ?? afs.bodies?.[0]?.text ?? "",
    headline: ld.name ?? afs.titles?.[0]?.text ?? "",
    description: ld.description ?? afs.descriptions?.[0]?.text ?? "",
    link: link && link !== FB_ME ? link : null,
    cta: ld.call_to_action?.type ?? afs.call_to_actions?.[0]?.type ?? afs.call_to_action_types?.[0] ?? "LEARN_MORE",
    leadFormId: leadFormId ? String(leadFormId) : null,
    imageUrl,
    imageHash,
  };
}

/** Resolve a full-res image URL from an image_hash (fallback when the creative had no direct URL). */
async function urlFromHash(hash: string): Promise<string | null> {
  try {
    const r = await metaGet<any>(`${adAccountId()}/adimages`, { hashes: JSON.stringify([hash]), fields: "hash,url,permalink_url" });
    const arr = Array.isArray(r?.data) ? r.data : r?.data ? Object.values(r.data) : [];
    const first: any = arr[0];
    return first?.url ?? first?.permalink_url ?? null;
  } catch {
    return null;
  }
}

/** Download an image and return it as a data URL (so the browser can rebuild a File from it). */
async function downloadAsDataUrl(url: string): Promise<{ dataUrl: string; type: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null; // sane cap
    return { dataUrl: `data:${type};base64,${buf.toString("base64")}`, type };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const supa = await createServerSupabase();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return NextResponse.json({ error: "Pick at least one ad to duplicate." }, { status: 400 });
  // "New creative" duplicate only needs the source's SETUP (ad set + lead form + link) — it supplies its
  // own new image — so skip the image download entirely (and don't drop ads whose image can't be fetched).
  const setupOnly = b.setupOnly === true;

  const admin = createAdminClient();
  const { data: rows } = await admin.from("ads").select("id, fb_ad_id, name, creative_thumb_url").in("id", ids);
  const found = (rows ?? []).filter((r: any) => r.fb_ad_id);
  if (!found.length) return NextResponse.json({ error: "Couldn't find those ads." }, { status: 400 });

  const out: any[] = [];
  const skipped: string[] = [];
  const formNameCache = new Map<string, string | null>();

  for (const r of found as any[]) {
    try {
      const ad = await metaGet<any>(r.fb_ad_id, {
        fields: "name,adset_id,creative{id,image_hash,image_url,thumbnail_url,object_story_spec,asset_feed_spec}",
      });
      const info = parseCreative(ad.creative);
      let imageDataUrl: string | null = null;
      if (!setupOnly) {
        let imageUrl = info.imageUrl;
        if (!imageUrl && info.imageHash) imageUrl = await urlFromHash(info.imageHash);
        if (!imageUrl) imageUrl = r.creative_thumb_url || null; // last resort (low-res)
        if (!imageUrl) { skipped.push(r.name || "an ad"); continue; }
        const img = await downloadAsDataUrl(imageUrl);
        if (!img) { skipped.push(r.name || "an ad"); continue; }
        imageDataUrl = img.dataUrl;
      }

      // Lead-form name (best-effort) so the grid can label the kept form.
      let leadFormName: string | null = null;
      if (info.leadFormId) {
        if (!formNameCache.has(info.leadFormId)) {
          try {
            const f = await metaGet<any>(info.leadFormId, { fields: "name" });
            formNameCache.set(info.leadFormId, f?.name ?? null);
          } catch {
            formNameCache.set(info.leadFormId, null);
          }
        }
        leadFormName = formNameCache.get(info.leadFormId) ?? null;
      }

      out.push({
        adId: r.id,
        name: ad.name || r.name || "Duplicated ad",
        adsetId: ad.adset_id ? String(ad.adset_id) : null,
        primaryText: info.message ? [info.message] : [""],
        headline: info.headline ? [info.headline] : [""],
        description: info.description ? [info.description] : [""],
        link: info.link || "",
        cta: KNOWN_CTAS.has(info.cta) ? info.cta : info.leadFormId ? "SIGN_UP" : "LEARN_MORE",
        leadFormId: info.leadFormId ? `meta:${info.leadFormId}` : null,
        leadFormName,
        imageDataUrl,
      });
    } catch (e: any) {
      console.error("[ads/duplicate-load] failed", { fbAdId: r.fb_ad_id, name: r.name, error: e?.message ?? String(e) });
      skipped.push(r.name || "an ad");
    }
  }

  if (!out.length) {
    return NextResponse.json({ error: "Couldn't load those ads for editing (videos or unsupported creatives can't be opened in the editor yet)." }, { status: 400 });
  }
  return NextResponse.json({ ads: out, skipped });
}
