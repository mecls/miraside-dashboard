import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pauseObject, resumeObject, archiveObject, setBudget, updateObject, copyObject, getAdCreativeInfo, uploadAdImage, createAdCreative, creativeFeatures, archiveLeadForm, deleteObject } from "@/lib/meta-ads";
import { metaGet } from "@/lib/meta";
import { getPrimaryTenantId } from "@/lib/tenant";
import { buildPositions, anyGroupOn } from "@/lib/placements";
import { runFacebookSync } from "@/lib/sync/facebook";
import { getUrlSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

/**
 * Manage an existing campaign or ad. Takes the dashboard's DB id, resolves the
 * Facebook object id server-side, performs the action on Meta, and mirrors the new
 * status into the DB so the dashboard reflects it immediately (before the next sync).
 */
export async function POST(req: Request) {
  const supa = await createServerSupabase();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: any;
  try {
    b = await req.json();
  } catch {
    return bad("Invalid request.");
  }
  const { dbId, level, action } = b;
  if (!dbId || !["campaign", "adset", "ad"].includes(level)) return bad("Bad request.");

  const admin = createAdminClient();
  const table = level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads";
  const fbCol = level === "campaign" ? "fb_campaign_id" : level === "adset" ? "fb_adset_id" : "fb_ad_id";
  const row = await admin.from(table).select(`id, ${fbCol}`).eq("id", dbId).maybeSingle();
  if (row.error || !row.data) return bad("Not found.");
  const fbId = (row.data as any)[fbCol] as string;

  try {
    let newStatus: string | null = null;
    if (action === "pause") {
      await pauseObject(fbId);
      newStatus = "PAUSED";
    } else if (action === "resume") {
      await resumeObject(fbId);
      newStatus = "ACTIVE";
    } else if (action === "archive") {
      await archiveObject(fbId);
      newStatus = "ARCHIVED";
    } else if (action === "budget") {
      const dailyEur = Number(b.dailyEur);
      if (!(dailyEur >= 1)) return bad("Budget must be at least €1.");
      await setBudget(fbId, { dailyEur });
    } else if (action === "rename") {
      const name = String(b.name ?? "").trim();
      if (!name) return bad("Enter a name.");
      if (name.length > 400) return bad("Name is too long (max 400 characters).");
      await updateObject(fbId, { name }); // writes the new name to Facebook
      const upd = await admin.from(table).update({ name }).eq("id", dbId); // mirror locally
      if (upd.error) {
        return NextResponse.json(
          { ok: false, error: "Renamed on Facebook, but the dashboard copy didn't update — refresh in a moment." },
          { status: 200 }
        );
      }
    } else if (action === "duplicate") {
      const copy = await copyObject(fbId, level as "campaign" | "adset" | "ad");
      // Best-effort: pull the new (paused) copy into the dashboard so it appears right away.
      try { await runFacebookSync(admin, { backfillDays: 1 }); } catch {}
      return NextResponse.json({ ok: true, duplicated: true, copyId: copy.id });
    } else if (action === "edit_adset") {
      const ageMin = Math.max(13, Math.min(65, Number(b.ageMin) || 29));
      const ageMax = Math.max(ageMin, Math.min(65, Number(b.ageMax) || 65));
      const fb = b.fb !== false;
      const ig = b.ig !== false;
      if (!fb && !ig) return bad("Pick at least one platform (Facebook or Instagram).");
      // Read current targeting and change ONLY what was edited (preserve placements/geo/etc.).
      const cur = await metaGet<any>(fbId, {
        fields: "targeting{age_min,age_max,genders,geo_locations,publisher_platforms,facebook_positions,instagram_positions,device_platforms,targeting_automation,brand_safety_content_filter_levels}",
      });
      const t: Record<string, any> = { ...(cur.targeting ?? {}) };
      delete t.age_range; // read-only echo; would be rejected on write
      t.age_min = ageMin;
      t.age_max = ageMax;
      t.publisher_platforms = [fb ? "facebook" : null, ig ? "instagram" : null].filter(Boolean);
      // Placements: if the editor sent groups, rebuild positions from them (manual placements,
      // limited-spend stays off because we never set placement_soft_opt_out). Else preserve current.
      if (b.placements) {
        if (!anyGroupOn(b.placements)) return bad("Pick at least one placement (Feeds, Stories, Reels or In-stream).");
        const pos = buildPositions(b.placements, fb, ig);
        if (pos.facebook_positions) t.facebook_positions = pos.facebook_positions; else delete t.facebook_positions;
        if (pos.instagram_positions) t.instagram_positions = pos.instagram_positions; else delete t.instagram_positions;
      } else {
        if (!fb) delete t.facebook_positions; // positions must match enabled platforms
        if (!ig) delete t.instagram_positions;
      }
      // Keep Advantage+ Audience setting, drop the echoed individual_setting (can be rejected on
      // write, and dropping it re-asserts the "Advantage expansion off" preset).
      if (t.targeting_automation) t.targeting_automation = { advantage_audience: t.targeting_automation.advantage_audience ? 1 : 0 };
      const fields: Record<string, any> = { targeting: t };
      const advertiser = String(b.advertiser ?? "").trim();
      if (advertiser) fields.dsa_beneficiary = advertiser; // EU "advertiser" disclosure
      await updateObject(fbId, fields);
      return NextResponse.json({ ok: true, edited: true });
    } else if (action === "edit_ad") {
      const name = String(b.name ?? "").trim();
      // Rebuild + swap the creative FIRST (so a rebuild failure doesn't leave a half-applied rename).
      if (b.rebuild) {
        const cur = await getAdCreativeInfo(fbId);
        let imageHash = cur.imageHash;
        if (b.imageBase64) imageHash = (await uploadAdImage(String(b.imageBase64).replace(/^data:image\/[a-z+]+;base64,/i, ""))).hash;
        if (!imageHash) return bad("Couldn't read the current image — upload a new one.");
        let leadFormId = cur.leadGenFormId ?? undefined;
        if (b.formMode === "saved") {
          const tenantId = await getPrimaryTenantId();
          const { data: tpl } = await admin
            .from("lead_form_templates").select("meta_form_id")
            .eq("id", String(b.templateId)).eq("tenant_id", tenantId).maybeSingle();
          if (!tpl?.meta_form_id) return bad("Saved form not found.");
          leadFormId = tpl.meta_form_id;
        }
        // A website (no-form) ad is legitimately formless — allow the rebuild. Only block when we can't tell
        // what the ad is (no form AND no destination link), so we never silently strip a real form (C23).
        if (b.formMode !== "saved" && !leadFormId && !cur.link) return bad("Couldn't read this ad — pick a saved form or re-import it.");
        const { defaultWebsiteUrl } = await getUrlSettings(admin);
        const cr = await createAdCreative({
          name: `${name || "ad"} — creative`,
          message: String(b.message ?? cur.message ?? "").trim() || " ",
          link: cur.link || defaultWebsiteUrl, // preserve the ad's real destination (+ landing-page params); never privacy
          headline: (b.headline ?? cur.headline) || undefined,
          description: cur.description || undefined, // carry the original description through the rebuild (C23)
          imageHash,
          leadGenFormId: leadFormId,
          callToAction: b.cta || cur.cta || "LEARN_MORE",
          degreesOfFreedom: creativeFeatures(b.autoCrop !== false),
        });
        // Swap (re-submits for review). If the swap fails, delete the new creative so it isn't orphaned;
        // on success, delete the old creative to avoid unbounded creative accumulation (C23).
        try {
          await updateObject(fbId, { creative: { creative_id: cr.id } });
        } catch (e) {
          await deleteObject(cr.id).catch(() => {});
          throw e;
        }
        if (cur.creativeId && cur.creativeId !== cr.id) await deleteObject(cur.creativeId).catch(() => {});
      }
      if (name) {
        await updateObject(fbId, { name });
        await admin.from("ads").update({ name }).eq("id", dbId);
      }
      // Best-effort: pull the new creative/thumbnail into the dashboard.
      try { await runFacebookSync(admin, { backfillDays: 1 }); } catch {}
      return NextResponse.json({ ok: true, edited: true });
    } else if (action === "archive_form") {
      const st = await metaGet<any>(fbId, { fields: "effective_status" });
      if (st.effective_status === "ACTIVE") return bad("Pause this ad before archiving its form — the ad is live.");
      const cur = await getAdCreativeInfo(fbId);
      if (!cur.leadGenFormId) return bad("This ad has no instant form to archive.");
      await archiveLeadForm(cur.leadGenFormId);
      return NextResponse.json({ ok: true, archived: true });
    } else {
      return bad("Unknown action.");
    }
    if (newStatus) await admin.from(table).update({ status: newStatus }).eq("id", dbId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Action failed." }, { status: 400 });
  }
}
