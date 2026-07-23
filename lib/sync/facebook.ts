/**
 * Facebook -> Supabase sync (backfill + incremental), as a reusable function.
 *
 * Single source of truth for the FB pull. Called by:
 *   - scripts/sync-facebook.ts  (CLI: `npm run sync:fb`, full backfill)
 *   - app/api/sync/facebook/route.ts  (n8n scheduled trigger, rolling window)
 *
 * Takes a service-role Supabase client as a parameter rather than importing the
 * `server-only`-guarded admin client, so the same code runs in the standalone
 * tsx script AND the Next.js server runtime.
 *
 * Pulls the ad hierarchy (campaigns -> adsets -> ads), daily insights, and
 * de-duplicated window-level reach/frequency, and upserts them idempotently.
 * Every window boundary is computed in the AD ACCOUNT timezone (see lib/time.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGet, metaGetAll, adAccountId } from "../meta";
import { todayInTz, addDays } from "../time";

const TENANT_NAME = "Miraside-AI";
const DEFAULT_BACKFILL_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 30; // matches reporting_window_days default
const WINDOW_RETENTION_DAYS = 120; // drop daily-shifted windows older than this

export interface SyncSummary {
  tenantId: string;
  account: { id: string; name: string; currency: string; timezone: string | null };
  accountToday: string;
  range: { daily: { since: string; until: string }; window: { since: string; until: string } };
  hierarchy: { campaigns: number; adsets: number; ads: number };
  removed: { campaigns: number; adsets: number; ads: number };
  rows: { daily: number; window: number };
  durationMs: number;
}

export interface SyncOptions {
  /** Days of daily insights to (re)pull. CLI uses 90 (full backfill); the scheduled route uses a short rolling window. */
  backfillDays?: number;
  /** Length of the de-duplicated reach/frequency window. Defaults to the reporting window (30). */
  windowDays?: number;
}

function num(v: any): number | null {
  return v == null || v === "" ? null : Number(v);
}
function* chunk<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

/**
 * SOFT-delete rows for objects no longer returned by Meta so the dashboard hides them WITHOUT destroying
 * their insight history (C41). Meta's account edges exclude ARCHIVED objects by default, so a hard delete
 * here would cascade-wipe a merely-archived ad's spend/lead history — instead we stamp deleted_at and the
 * read layer filters it out; a re-appearing object un-deletes on its next upsert. SAFETY: never runs on an
 * empty live set, and skips (with an alert) an implausibly large shrink so a partial pull can't mass-hide.
 */
async function reconcileDeleted(sb: SupabaseClient, table: string, fbCol: string, tenantId: string, liveIds: string[]): Promise<number> {
  if (!liveIds.length) return 0;
  const { count: storedCount } = await sb
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  // Guard: if the live set is a tiny fraction of what we have, treat the pull as suspect and skip.
  if (storedCount && storedCount >= 4 && liveIds.length < storedCount * 0.5) {
    console.warn(`reconcileDeleted(${table}): live=${liveIds.length} vs stored=${storedCount} — implausible shrink, skipping soft-delete`);
    return 0;
  }
  const { error, count } = await sb
    .from(table)
    .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .not(fbCol, "in", `(${liveIds.join(",")})`);
  if (error) throw error;
  return count ?? 0;
}

/** Distinct image hashes a creative references, in best-first order. */
function creativeImageHashes(c: any): string[] {
  if (!c) return [];
  const raw = [
    c.object_story_spec?.link_data?.image_hash,
    c.image_hash,
    ...(Array.isArray(c.asset_feed_spec?.images) ? c.asset_feed_spec.images.map((i: any) => i?.hash) : []),
  ];
  return Array.from(new Set(raw.filter((h: any): h is string => typeof h === "string" && h.length > 0)));
}

/**
 * Resolve image hashes → original full-resolution URLs via batched `adimages` calls.
 * We store the CDN `url` (the scontent/fbcdn image) — it serves the raw JPEG to an anonymous
 * `<img>`, whereas `permalink_url` (facebook.com/ads/image) 302s to login for logged-out viewers
 * and won't render. The CDN url carries an expiry, but the regular sync keeps it fresh. Best-effort:
 * any hash that fails to resolve simply falls back to a lower-res source in bestCreativeImage.
 */
async function resolveImageHashes(hashes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(hashes)).filter(Boolean);
  for (let i = 0; i < unique.length; i += 50) {
    const slice = unique.slice(i, i + 50);
    try {
      const r = await metaGet<any>(`${adAccountId()}/adimages`, {
        hashes: JSON.stringify(slice),
        fields: "hash,url,permalink_url",
      });
      const arr = Array.isArray(r?.data) ? r.data : r?.data ? Object.values(r.data) : [];
      for (const img of arr as any[]) {
        const url = img?.url ?? img?.permalink_url;
        if (img?.hash && url) map.set(img.hash, url);
      }
    } catch {
      // leave this chunk's hashes unresolved; bestCreativeImage falls back to a direct URL
    }
  }
  return map;
}

/**
 * Best available full-resolution creative image (handles image, page-post, dynamic, and
 * Advantage+/asset_feed_spec ads). Advantage+ creatives expose only an image *hash* plus a
 * tiny (~64px) thumbnail_url, so we resolve the hash to the original upload first — without
 * this, the stored "full" image is just the 64px thumbnail and renders blurry when enlarged.
 */
function bestCreativeImage(c: any, hashUrls: Map<string, string>): string | null {
  if (!c) return null;
  for (const h of creativeImageHashes(c)) {
    const u = hashUrls.get(h);
    if (u) return u; // original full-res upload — highest fidelity
  }
  return (
    c.image_url ??
    c.object_story_spec?.link_data?.picture ??
    c.object_story_spec?.video_data?.image_url ??
    c.asset_feed_spec?.images?.[0]?.url ??
    c.thumbnail_url ?? // last resort: a small (~64px) thumbnail
    null
  );
}

function leadsFromActions(actions: any[] | undefined): number | null {
  if (!Array.isArray(actions)) return null;
  const byType: Record<string, number> = {};
  for (const a of actions) byType[a.action_type] = Number(a.value || 0);
  // These action types OVERLAP (Meta's `lead` aggregate already includes the
  // on-Facebook lead-form conversions). Pick ONE in priority order — never sum,
  // or leads (and CPL/conv-rate/the spend gate) get double-counted.
  const lead =
    byType["lead"] ??
    byType["onsite_conversion.lead_grouped"] ??
    byType["leadgen.other_optin"];
  return lead ?? 0;
}
function lpvFromActions(actions: any[] | undefined): number | null {
  if (!Array.isArray(actions)) return null;
  const lpv = actions.find((a) => a.action_type === "landing_page_view");
  return lpv ? Number(lpv.value) : null;
}

export async function runFacebookSync(sb: SupabaseClient, opts: SyncOptions = {}): Promise<SyncSummary> {
  const startedAt = Date.now();
  const backfillDays = opts.backfillDays ?? DEFAULT_BACKFILL_DAYS;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const account = adAccountId();

  // 1. Tenant #1 (find-or-create)
  let tenantId: string;
  const existing = await sb.from("tenants").select("id").eq("name", TENANT_NAME).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    tenantId = existing.data.id;
  } else {
    const ins = await sb.from("tenants").insert({ name: TENANT_NAME }).select("id").single();
    if (ins.error) throw ins.error;
    tenantId = ins.data.id;
  }

  // 2. Account details + EUR guard
  const acct = await metaGet<{ name: string; currency: string; timezone_name: string }>(account, {
    fields: "name,currency,timezone_name,account_status",
  });
  if (acct.currency !== "EUR") {
    throw new Error(`Ad account currency is ${acct.currency}; this dashboard is EUR-only.`);
  }
  // Account timezone drives EVERY date boundary below — never the server's UTC.
  const tz = acct.timezone_name;
  const accountToday = todayInTz(tz);

  const accUp = await sb
    .from("ad_accounts")
    .upsert(
      { tenant_id: tenantId, fb_account_id: account, currency: acct.currency, timezone_name: acct.timezone_name },
      { onConflict: "tenant_id,fb_account_id" }
    )
    .select("id")
    .single();
  if (accUp.error) throw accUp.error;
  const adAccountRowId = accUp.data.id;

  // last_synced_at is a real timestamp (last_completed_date is only a DATE) so the dashboard can show an
  // accurate "synced Nm ago" and surface staleness the moment a scheduler misses a tick. Log (don't throw)
  // on failure: this is a metadata stamp gating no ad data, so a blip here must never abort the whole sync —
  // but it must not be swallowed silently either (e.g. a missing column if the migration lagged the deploy).
  const cxn = await sb.from("connections").upsert(
    { tenant_id: tenantId, provider: "facebook", status: "connected", last_completed_date: accountToday, last_synced_at: new Date().toISOString() },
    { onConflict: "tenant_id,provider" }
  );
  if (cxn.error) console.error("connections upsert failed (freshness stamp not updated):", cxn.error.message);

  // 3. Campaigns
  const campaigns = await metaGetAll<any>(`${account}/campaigns`, {
    fields: "id,name,status,daily_budget,lifetime_budget",
    limit: "200",
  });
  const campMap = new Map<string, string>();
  if (campaigns.length) {
    const rows = campaigns.map((c) => ({
      tenant_id: tenantId,
      ad_account_id: adAccountRowId,
      fb_campaign_id: c.id,
      name: c.name,
      status: c.status,
      budget_level: c.daily_budget || c.lifetime_budget ? "cbo" : "abo",
      deleted_at: null, // present in the pull → active (un-soft-delete if it had been reconciled away)
    }));
    const res = await sb.from("campaigns").upsert(rows, { onConflict: "tenant_id,fb_campaign_id" }).select("id,fb_campaign_id");
    if (res.error) throw res.error;
    res.data!.forEach((r: any) => campMap.set(r.fb_campaign_id, r.id));
  }

  // 4. Adsets
  const adsets = await metaGetAll<any>(`${account}/adsets`, {
    fields: "id,name,status,campaign_id,daily_budget,lifetime_budget",
    limit: "500",
  });
  const adsetMap = new Map<string, string>();
  const adsetRows = adsets
    .filter((a) => campMap.has(a.campaign_id))
    .map((a) => ({
      tenant_id: tenantId,
      campaign_id: campMap.get(a.campaign_id)!,
      fb_adset_id: a.id,
      name: a.name,
      status: a.status,
      budget_level: a.daily_budget || a.lifetime_budget ? "abo" : "cbo",
      deleted_at: null,
    }));
  if (adsetRows.length) {
    const res = await sb.from("adsets").upsert(adsetRows, { onConflict: "tenant_id,fb_adset_id" }).select("id,fb_adset_id");
    if (res.error) throw res.error;
    res.data!.forEach((r: any) => adsetMap.set(r.fb_adset_id, r.id));
  }

  // 5. Ads
  const ads = await metaGetAll<any>(`${account}/ads`, {
    fields:
      "id,name,status,effective_status,adset_id,creative{thumbnail_url,image_url,image_hash,object_story_spec{link_data{image_hash,picture},video_data{image_url}},asset_feed_spec{images{hash,url}}}",
    thumbnail_width: "600",
    thumbnail_height: "600",
    limit: "500",
  });
  // Resolve every referenced image hash to its original full-res URL in one batched pass,
  // so Advantage+ creatives (hash-only, 64px thumbnail) get a high-definition image.
  const hashUrls = await resolveImageHashes(ads.flatMap((a) => creativeImageHashes(a.creative)));
  const adMap = new Map<string, string>();
  const adRows = ads
    .filter((a) => adsetMap.has(a.adset_id))
    .map((a) => ({
      tenant_id: tenantId,
      adset_id: adsetMap.get(a.adset_id)!,
      fb_ad_id: a.id,
      name: a.name,
      status: a.status,
      effective_status: a.effective_status ?? null,
      creative_thumb_url: a.creative?.thumbnail_url ?? null,
      creative_image_url: bestCreativeImage(a.creative, hashUrls),
      deleted_at: null,
    }));
  if (adRows.length) {
    const res = await sb.from("ads").upsert(adRows, { onConflict: "tenant_id,fb_ad_id" }).select("id,fb_ad_id");
    if (res.error) throw res.error;
    res.data!.forEach((r: any) => adMap.set(r.fb_ad_id, r.id));
  }

  // 5b. Reconcile deletions — drop campaigns/adsets/ads removed in Ads Manager (cascades to children).
  const removed = {
    campaigns: await reconcileDeleted(sb, "campaigns", "fb_campaign_id", tenantId, campaigns.map((c) => c.id)),
    adsets: await reconcileDeleted(sb, "adsets", "fb_adset_id", tenantId, adsets.map((a) => a.id)),
    ads: await reconcileDeleted(sb, "ads", "fb_ad_id", tenantId, ads.map((a) => a.id)),
  };

  // 5c. Roll each launch's CURRENT ad statuses up into Launch History. A launch is recorded as it was
  // created (always PAUSED — our hard rule), so without this a launch you've since switched on in Ads
  // Manager still reads "Paused" forever. Uses the statuses already fetched above — no extra Meta calls.
  // MIXED = some of the launch's ads are on and some aren't.
  try {
    const { data: launchRows } = await sb
      .from("ad_launches")
      .select("id, fb_ad_ids")
      .eq("tenant_id", tenantId)
      .not("fb_ad_ids", "is", null);
    const liveById = new Map(ads.map((a: any) => [String(a.id), String(a.status ?? "").toUpperCase()]));
    for (const l of (launchRows ?? []) as any[]) {
      const ids: string[] = Array.isArray(l.fb_ad_ids) ? l.fb_ad_ids : [];
      const states = ids.map((id) => liveById.get(String(id))).filter(Boolean) as string[];
      if (!states.length) continue; // ads archived/deleted on Meta — keep the last known value
      const on = states.filter((s) => s === "ACTIVE").length;
      await sb
        .from("ad_launches")
        .update({ live_status: on === 0 ? "PAUSED" : on === states.length ? "ACTIVE" : "MIXED" })
        .eq("id", l.id);
    }
  } catch {
    // A rollup failure must never break the sync.
  }

  // Excluded (operator-removed) leads — e.g. a friend's test signup. Subtract each from its ad/day Meta
  // lead count so the dashboard totals are accurate, without disturbing real co-leads on the same ad/day.
  const { data: exLeads } = await sb
    .from("lead_exclusions")
    .select("fb_ad_id, lead_date")
    .eq("tenant_id", tenantId)
    .not("fb_ad_id", "is", null)
    .not("lead_date", "is", null);
  const excludedLeadCount = new Map<string, number>();
  for (const e of exLeads ?? []) {
    const k = `${e.fb_ad_id}|${e.lead_date}`;
    excludedLeadCount.set(k, (excludedLeadCount.get(k) ?? 0) + 1);
  }

  // 6. Daily insights (per-ad, time_increment=1) — boundaries in the account timezone.
  const since = addDays(accountToday, -backfillDays); // anchor to the single accountToday (not a per-call "now") so a midnight-straddling sync stays coherent (C47)
  const until = accountToday;
  const daily = await metaGetAll<any>(`${account}/insights`, {
    level: "ad",
    time_increment: "1",
    fields: "ad_id,spend,impressions,clicks,inline_link_clicks,ctr,inline_link_click_ctr,cpc,cpm,reach,frequency,actions",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  });
  const dailyRows = daily
    .filter((r) => adMap.has(r.ad_id))
    .map((r) => ({
      tenant_id: tenantId,
      ad_id: adMap.get(r.ad_id)!,
      date: r.date_start,
      spend: num(r.spend) ?? 0,
      impressions: num(r.impressions) ?? 0,
      clicks: num(r.clicks) ?? 0,
      link_clicks: num(r.inline_link_clicks) ?? 0,
      ctr: num(r.ctr),
      link_ctr: num(r.inline_link_click_ctr),
      cpc: num(r.cpc),
      cpm: num(r.cpm),
      reach: num(r.reach),
      frequency: num(r.frequency),
      fb_leads: (() => {
        const raw = leadsFromActions(r.actions);
        const ex = excludedLeadCount.get(`${r.ad_id}|${r.date_start}`) ?? 0;
        return raw == null || ex === 0 ? raw : Math.max(0, raw - ex); // drop operator-excluded leads from the count
      })(),
      landing_page_views: lpvFromActions(r.actions),
      actions_json: r.actions ?? null,
    }));
  let dailyCount = 0;
  for (const c of chunk(dailyRows, 500)) {
    const res = await sb.from("fb_insights_daily").upsert(c, { onConflict: "tenant_id,ad_id,date" });
    if (res.error) throw res.error;
    dailyCount += c.length;
  }

  // C46: remove stale in-range rows Meta no longer reports (a day restated to zero / an ad dropped from
  // the pull) so the dashboard can't keep showing spend Ads Manager has since zeroed. Guarded: only when
  // the pull returned data (metaGetAll throws on failure) so a transient empty/failed pull never wipes history.
  if (daily.length > 0) {
    const kept = new Set(dailyRows.map((r) => `${r.ad_id}|${r.date}`));
    const existing: { id: string; ad_id: string; date: string }[] = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await sb
        .from("fb_insights_daily")
        .select("id,ad_id,date")
        .eq("tenant_id", tenantId)
        .gte("date", since)
        .lte("date", until)
        .range(start, start + 999);
      if (error) throw error;
      existing.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const staleIds = existing.filter((e) => !kept.has(`${e.ad_id}|${e.date}`)).map((e) => e.id);
    for (const c of chunk(staleIds, 200)) {
      const res = await sb.from("fb_insights_daily").delete().in("id", c);
      if (res.error) throw res.error;
    }
  }

  // 7. Window reach (de-duplicated, aggregated over the reporting window) — account tz.
  const wSince = addDays(accountToday, -(windowDays - 1)); // inclusive N-day window, anchored to accountToday (C47)
  const wUntil = accountToday;
  const win = await metaGetAll<any>(`${account}/insights`, {
    level: "ad",
    fields: "ad_id,reach,frequency,impressions",
    time_range: JSON.stringify({ since: wSince, until: wUntil }),
    limit: "500",
  });
  const winRows = win
    .filter((r) => adMap.has(r.ad_id))
    .map((r) => ({
      tenant_id: tenantId,
      ad_id: adMap.get(r.ad_id)!,
      window_start: wSince,
      window_end: wUntil,
      reach: num(r.reach),
      frequency: num(r.frequency),
      impressions: num(r.impressions),
    }));
  if (winRows.length) {
    const res = await sb
      .from("fb_insights_window")
      .upsert(winRows, { onConflict: "tenant_id,ad_id,window_start,window_end" });
    if (res.error) throw res.error;
  }

  // Retention: drop window rows older than ~120 days so daily-shifted windows don't accumulate.
  await sb.from("fb_insights_window").delete().eq("tenant_id", tenantId).lt("window_end", addDays(accountToday, -WINDOW_RETENTION_DAYS));

  return {
    tenantId,
    account: { id: account, name: acct.name, currency: acct.currency, timezone: tz ?? null },
    accountToday,
    range: { daily: { since, until }, window: { since: wSince, until: wUntil } },
    hierarchy: { campaigns: campMap.size, adsets: adsetMap.size, ads: adMap.size },
    removed,
    rows: { daily: dailyCount, window: winRows.length },
    durationMs: Date.now() - startedAt,
  };
}
