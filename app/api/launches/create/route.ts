import { NextResponse, after } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { launchRowsFromPaths, createLaunchStructure, type NewAdSetConfig, type AudienceConfig } from "@/lib/launch";
import { BATCH_SIZE, BATCH_INTERVAL_MS, friendlyError, triggerProcess } from "@/lib/launch-batch";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Start a launch. We validate, mark a "LAUNCHING" history record, respond IMMEDIATELY, and then create the
 * ads in after() — so the work runs server-side (paced, all PAUSED) regardless of whether the user's tab
 * stays open. The history entry flips to PAUSED/PARTIAL when done, or reverts to a reopenable DRAFT on a
 * full failure. Auth-gated.
 */
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return NextResponse.json({ error: "Nothing to launch" }, { status: 400 });
  if (new Set(rows.map((r) => r.format)).size > 1) return NextResponse.json({ error: "All ads in a launch must be the same format" }, { status: 400 });

  let newAdSet: NewAdSetConfig | undefined;
  if (body.adSetMode === "new" && body.newAdSet) {
    const n = body.newAdSet as any;
    // One ad set per audience. Each carries its own targeting + destination (instant form vs landing page).
    const audiences: AudienceConfig[] = Array.isArray(n.audiences)
      ? n.audiences.map((a: any, i: number) => ({
          id: String(a.id ?? `aud_${i}`),
          name: String(a.name || "").trim() || `Audience ${i + 1}`,
          countries: Array.isArray(a.countries) && a.countries.length ? a.countries.map(String) : undefined,
          ageMin: a.ageMin != null ? Number(a.ageMin) : undefined,
          ageMax: a.ageMax != null ? Number(a.ageMax) : undefined,
          genders: Array.isArray(a.genders) && a.genders.length ? a.genders.map(Number) : null,
          advantageAudience: !!a.advantageAudience,
          facebook: a.facebook !== false,
          instagram: a.instagram !== false,
          placements: Array.isArray(a.placements) && a.placements.length ? a.placements.map(String) : undefined,
          optimizationGoal: a.optimizationGoal ? String(a.optimizationGoal) : undefined,
          attributionDays: a.attributionDays != null ? Number(a.attributionDays) : undefined,
          destination: a.destination === "site" ? "site" : "form",
          landingUrl: a.landingUrl ? String(a.landingUrl).trim() : "",
        }))
      : [];
    newAdSet = {
      campaignName: String(n.campaignName || "").trim(),
      dailyBudgetEur: Number(n.dailyBudgetEur),
      campaignMode: n.campaignMode === "existing" ? "existing" : "new",
      campaignId: n.campaignId ? String(n.campaignId) : undefined,
      adSetName: n.adSetName ? String(n.adSetName).trim() : undefined,
      budgetMode: n.budgetMode === "abo" ? "abo" : "cbo",
      structured: !!n.structured,
      audiences: audiences.length ? audiences : undefined,
      countries: Array.isArray(n.countries) && n.countries.length ? n.countries.map(String) : undefined,
      ageMin: n.ageMin != null ? Number(n.ageMin) : undefined,
      ageMax: n.ageMax != null ? Number(n.ageMax) : undefined,
      genders: Array.isArray(n.genders) && n.genders.length ? n.genders.map(Number) : null,
      advantageAudience: !!n.advantageAudience,
      facebook: n.facebook !== false,
      instagram: n.instagram !== false,
      placements: Array.isArray(n.placements) && n.placements.length ? n.placements.map(String) : undefined,
      optimizationGoal: n.optimizationGoal ? String(n.optimizationGoal) : undefined,
      attributionDays: n.attributionDays != null ? Number(n.attributionDays) : undefined,
      scheduleStart: n.scheduleStart ? String(n.scheduleStart) : undefined,
      scheduleEnd: n.scheduleEnd ? String(n.scheduleEnd) : undefined,
    };
    if (newAdSet.campaignMode === "existing") {
      if (!newAdSet.campaignId) return NextResponse.json({ error: "Pick a campaign for the new ad set" }, { status: 400 });
    } else if (!newAdSet.campaignName || !(newAdSet.dailyBudgetEur >= 1)) {
      return NextResponse.json({ error: "Name the campaign and set a daily budget of at least €1" }, { status: 400 });
    }
    // Every audience needs a platform; every landing-page audience needs a URL.
    const checkList = newAdSet.audiences ?? [{ name: "", facebook: newAdSet.facebook, instagram: newAdSet.instagram, destination: "form" as const, landingUrl: "" }];
    for (const a of checkList) {
      const who = a.name ? `"${a.name}"` : "the audience";
      if (a.facebook === false && a.instagram === false) {
        return NextResponse.json({ error: `Turn on at least one platform (Facebook or Instagram) for ${who}` }, { status: 400 });
      }
      if (a.destination === "site" && !(a.landingUrl || "").trim()) {
        return NextResponse.json({ error: `Add a landing-page URL for ${who}` }, { status: 400 });
      }
    }
  }

  const admin = createAdminClient();
  const launchName = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Launch";
  const format = typeof rows[0]?.format === "string" ? rows[0].format : null;
  const draftId = typeof body.draftId === "string" && body.draftId ? body.draftId : null;
  // Durable data-URL thumbnails for the history preview (self-contained — survive the post-launch image cleanup).
  const thumbUrls: string[] = Array.isArray(body.thumbUrls) ? body.thumbUrls.filter((u: unknown) => typeof u === "string" && (u as string).startsWith("data:")).slice(0, 16) : [];

  // Claim/insert the history record up front, marked LAUNCHING, so the user sees live progress. When the
  // launch is from a saved draft we transition THAT record (DRAFT → LAUNCHING → PAUSED, or back to DRAFT on
  // failure) so there's never a duplicate or a dead entry.
  const startedAt = new Date().toISOString();
  let recordId: string | null = null;
  if (draftId) {
    // Refresh the draft's thumbnails to the durable data URLs (its stored signed URLs would break post-cleanup).
    const rec: Record<string, unknown> = { status: "LAUNCHING", launched_at: startedAt };
    if (thumbUrls.length) rec.thumb_urls = thumbUrls;
    // Atomic claim: only transition a record that is still a DRAFT. A second tab / double-submit that lost
    // the race matches zero rows here and is refused, so we never run two after() jobs for one draft (C12).
    const u = await admin.from("ad_launches").update(rec).eq("id", draftId).eq("tenant_id", tenantId).eq("status", "DRAFT").select("id").maybeSingle();
    recordId = (u.data as any)?.id ?? null;
    if (!recordId) return NextResponse.json({ error: "This draft is already launching." }, { status: 409 });
  }
  if (!recordId) {
    const ins = await admin.from("ad_launches").insert({ tenant_id: tenantId, name: launchName, status: "LAUNCHING", format, ad_count: 0, thumb_urls: thumbUrls, launched_at: startedAt }).select("id").maybeSingle();
    recordId = (ins.data as any)?.id ?? null;
  }

  const cleanup = (paths: string[]) => (paths.length ? admin.storage.from("launch-media").remove(paths).then(() => {}, () => {}) : Promise.resolve());
  const failRecord = (reason: string) =>
    recordId
      ? admin.from("ad_launches").update({ status: draftId ? "DRAFT" : "FAILED", last_error: friendlyError(reason), pending: null }).eq("id", recordId).then(() => {}, () => {})
      : Promise.resolve();

  // Batchable = a single-ad-set launch (one audience, plain single/carousel ads) with more ads than one batch.
  // Those get split across paced background batches so the burst never trips the Development-tier rate limit.
  const isSimple = (r: any) =>
    (r.format === "single" || r.format === "carousel") &&
    ![r.primaryText, r.headline, r.description].some((a: any) => Array.isArray(a) && a.filter((v: any) => (v || "").trim()).length > 1);
  const batchable = !!newAdSet && (newAdSet.audiences?.length ?? 0) <= 1 && rows.every(isSimple) && rows.length > BATCH_SIZE;
  // "One ad set per folder": every ad is a plain single-image ad targeting exactly its own bucket. Build the
  // campaign + all ad sets up front, then drain the ads into them in paced batches so a big 8-ad-set launch
  // never fires ~90 writes in one burst (Meta code 17). Takes precedence over the single-ad-set `batchable`.
  const structuredBatchable =
    !!newAdSet && !!newAdSet.structured && (newAdSet.audiences?.length ?? 0) >= 1 && rows.every(isSimple) && rows.length > BATCH_SIZE;

  // ---- Background work (runs after the response is sent; up to maxDuration) ----
  after(async () => {
    try {
      if (structuredBatchable && newAdSet) {
        // Batch 0: create the campaign + all ad sets (one per folder bucket) up front — no ads yet.
        let structure: { campaignId: string; adSetByAudience: Record<string, string> };
        try {
          structure = await createLaunchStructure(newAdSet);
        } catch (e: any) {
          await failRecord(e?.message || "Couldn't create the campaign structure.");
          return;
        }
        const { adSetByAudience } = structure;
        const audById = new Map((newAdSet.audiences ?? []).map((a) => [a.id, a]));
        // Resolve every ad to its bucket's ad set + that bucket's destination, matching prepareNewAdSets's
        // site/form normalization so a batched ad builds the SAME creative type as it would inline.
        const pendingRows: any[] = [];
        const orphanImages: string[] = [];
        for (const r of rows) {
          const bucketId = Array.isArray(r.audienceIds) && r.audienceIds.length ? String(r.audienceIds[0]) : null;
          const adSetId = bucketId ? adSetByAudience[bucketId] : null;
          if (!adSetId) {
            if (Array.isArray(r.imagePaths)) orphanImages.push(...r.imagePaths.filter((p: any): p is string => typeof p === "string" && !!p));
            continue;
          }
          const aud = bucketId ? audById.get(bucketId) : null;
          const isSite = aud?.destination === "site";
          const url = (aud?.landingUrl || "").trim();
          pendingRows.push({
            ...r,
            adSetIds: [adSetId],
            audienceIds: [],
            ...(isSite ? { link: url || r.link, leadFormId: null } : { afterSubmitUrl: url || undefined }),
          });
        }
        await cleanup(orphanImages);
        if (!pendingRows.length) {
          await failRecord("No ads could be placed into the new ad sets.");
          return;
        }
        // The user may have cancelled while the structure was being created — don't queue any ads. The empty
        // paused ad sets are harmless (nothing live); leave them and record a clear PARTIAL.
        const cur = recordId ? await admin.from("ad_launches").select("status").eq("id", recordId).maybeSingle() : null;
        if (cur?.data && (cur.data as any).status !== "LAUNCHING") {
          await admin
            .from("ad_launches")
            .update({ status: "PARTIAL", ad_count: 0, draft_state: null, pending: null, last_error: "Launch cancelled before any ads were created. The empty ad sets were left paused — delete them in Ads Manager if unneeded." })
            .eq("id", recordId!);
          return;
        }
        if (recordId) {
          await admin.from("ad_launches").update({
            status: "LAUNCHING",
            ad_count: 0,
            total_ads: pendingRows.length,
            draft_state: null,
            last_error: null,
            pending: { rows: pendingRows, nextAt: new Date(Date.now() + BATCH_INTERVAL_MS).toISOString(), stalls: 0 },
          }).eq("id", recordId);
        }
        await triggerProcess();
        return;
      }

      if (batchable && newAdSet) {
        // Batch 1: create the campaign + ad set + the first slice of ads.
        const batch1 = rows.slice(0, BATCH_SIZE);
        const { result } = await launchRowsFromPaths(admin, tenantId, batch1, newAdSet);
        const adSetIds = Array.from(new Set(result.created.map((c) => c.adSetId).filter(Boolean)));
        if (!result.created.length || !adSetIds.length) {
          await failRecord(result.errors[0]?.error || "No ads were created.");
          return;
        }
        // Clean up ONLY the images of ads that were actually created; a FAILED batch-1 row keeps its image
        // so it can be requeued and retried (deleting all batch-1 images + dropping failed rows was the gap) (C15).
        const createdNames = new Set(result.created.map((c) => c.name));
        const pathsOf = (rs: any[]) =>
          Array.from(new Set(rs.flatMap((r) => (Array.isArray(r.imagePaths) ? r.imagePaths : [])).filter((p: any): p is string => typeof p === "string" && !!p)));
        await cleanup(pathsOf(batch1.filter((r) => createdNames.has(r.name))));
        // Queue the rest into that same ad set, carrying the audience's destination (landing URL / after-submit).
        // Failed batch-1 rows are re-queued too (C15/C16) so under-delivery is retried, not silently dropped.
        const aud = newAdSet.audiences?.[0];
        const isSite = aud?.destination === "site";
        const destUrl = (aud?.landingUrl || "").trim();
        const failedBatch1 = batch1.filter((r) => !createdNames.has(r.name));
        const rest = [...failedBatch1, ...rows.slice(BATCH_SIZE)].map((r) => ({
          ...r,
          adSetIds,
          audienceIds: [],
          // Match prepareNewAdSets's site normalization so later batches build the SAME ad type as batch 1:
          // a landing-page launch must null the lead form (else batches 2+ become instant-form ads with no
          // url_tags attribution pointing at the default site) (C11).
          ...(isSite ? { link: destUrl || r.link, leadFormId: null } : { afterSubmitUrl: destUrl || undefined }),
        }));
        // The user may have hit Cancel while batch 1 was creating — don't resurrect the queue. Record the
        // ads that WERE created and rest at PARTIAL with an accurate message; clear draft_state so a stale
        // DRAFT can't be relaunched into duplicate paused ads (C14).
        const cur = recordId ? await admin.from("ad_launches").select("status").eq("id", recordId).maybeSingle() : null;
        if (cur?.data && (cur.data as any).status !== "LAUNCHING") {
          const n = result.created.length;
          await admin
            .from("ad_launches")
            .update({ status: "PARTIAL", ad_count: n, draft_state: null, pending: null, last_error: `Launch cancelled — ${n} ad${n === 1 ? "" : "s"} already created (paused). The rest were stopped.` })
            .eq("id", recordId!);
          return;
        }
        if (recordId) {
          await admin.from("ad_launches").update({
            status: "LAUNCHING",
            ad_count: result.created.length,
            total_ads: rows.length,
            fb_ad_ids: result.created.map((c) => c.adId), // link to the ads so the sync can roll their live status up
            draft_state: null,
            last_error: null,
            pending: { rows: rest, nextAt: new Date(Date.now() + BATCH_INTERVAL_MS).toISOString(), stalls: 0 },
          }).eq("id", recordId);
        }
        await triggerProcess();
        return;
      }

      // Non-batchable: launch everything at once.
      const { result, paths } = await launchRowsFromPaths(admin, tenantId, rows, newAdSet);
      await cleanup(paths);
      if (recordId) {
        if (result.created.length > 0) {
          await admin.from("ad_launches").update({ status: result.errors.length === 0 ? "PAUSED" : "PARTIAL", ad_count: result.created.length, fb_ad_ids: result.created.map((c) => c.adId), draft_state: null, last_error: null, pending: null }).eq("id", recordId);
        } else {
          await failRecord(result.errors[0]?.error || "No ads were created.");
        }
      }
    } catch (e: any) {
      await failRecord(e?.message || "The launch crashed.");
    }
  });

  return NextResponse.json({ ok: true, launching: true, id: recordId });
}
