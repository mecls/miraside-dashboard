import { createAdminClient } from "./supabase/admin";
import { computeFlags, type Flag, type FlagInput } from "./flags";
import { todayInTz, daysAgoInTz, addDays, dateInTz } from "./time";
import { getPrimaryTenantId } from "./tenant";

// A well-formed YYYY-MM-DD that parses to a real date (guards SQL date filters + date math against
// malformed ?from/?to URL params, which would otherwise throw a RangeError and 500 the page).
function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

// PostgREST caps an unbounded select at ~1000 rows. The insight tables grow with ads×days, so page
// through .range() to get the full set — otherwise recent days are silently dropped from totals (C39).
async function selectAllPaged<T>(makeQuery: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await makeQuery(start, start + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export type Settings = Record<string, any>;
export type FreqBand = "prospecting" | "mid" | "retargeting";

// Trailing-window math on a YYYY-MM-DD string (timezone-independent day arithmetic).
function isoDaysBefore(dateStr: string, n: number): string {
  return addDays(dateStr, -n);
}
function daysInclusive(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface DayPoint {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  ctr: number | null;
  cpm: number | null;
  /** true when this is the account-local current day (still accumulating; not a complete day). */
  partial: boolean;
}

export interface AdPerf {
  id: string;
  name: string;
  status: string;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  fbAdId: string;
  fbAdsetId: string | null;
  thumb: string | null;
  imageUrl: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  lpViews: number;
  reach: number | null;
  frequency: number | null;
  ctr: number | null;
  linkCtr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
  costPerResult: number | null;
  spendSharePct: number;
  gated: boolean;
  freqBand: FreqBand | null;
  flags: Flag[];
  daily: DayPoint[];
}

export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  cpl: number | null;
  ctr: number | null;
  cpm: number | null;
  convRate: number | null;
}

export interface TimePoint {
  date: string;
  spend: number;
  leads: number;
  impressions: number;
  /** true when this is the account-local current day (still accumulating). */
  partial: boolean;
}
export interface WeekPoint {
  week: string; // the Monday (account-tz) of this Mon–Sun week
  leads: number;
  spend: number;
  partial: boolean; // true for the in-progress current week (not a full 7 days yet)
}
export interface CampaignSummary {
  id: string;
  fbId: string;
  name: string;
  status: string;
  spend: number;
  leads: number;
  impressions: number;
  adCount: number;
}
export interface AdSetSummary {
  id: string;
  fbId: string;
  fbCampaignId: string;
  name: string;
  status: string;
  campaignId: string;
  spend: number;
  leads: number;
  impressions: number;
  adCount: number;
  cpl: number | null;
}

export interface Dashboard {
  account: { fb_account_id: string; currency: string; timezone_name: string | null } | null;
  range: { from: string; to: string; days: number };
  /** Current day in the account timezone; daily/weekly points on this date are partial. */
  accountToday: string;
  reachWindowDays: number;
  settings: Settings;
  targetCpl: number;
  spendGate: number;
  minResults: number;
  totals: Totals;
  ads: AdPerf[];
  campaigns: CampaignSummary[];
  adsets: AdSetSummary[];
  allGated: boolean;
  daily: TimePoint[];
  weekly: WeekPoint[];
  topCreatives: AdPerf[];
  funnelLeads: number;
  /** Captured leads across EVERY channel (ads + outbound + direct) in the range — the CRM's own count,
   *  deliberately separate from the Meta-reported `totals.leads`. */
  allChannelLeads: { total: number; ads: number; outbound: number; direct: number };
  /** Median ms from an AD lead's creation to its first call attempt (null = nothing sampled in range). */
  speedToLead: { medianMs: number | null; sampled: number };
  /** Donut breakdowns per acquisition source, range-filtered by account-tz day. Same attribution
   *  buckets as `allChannelLeads` (ads = anything ad-attributed). Leads/meetings by their own day;
   *  closed/revenue by the CLOSE day (won meeting outcome, or the GHL opportunity's won date). */
  bySource: {
    leads: { key: string; label: string; count: number }[];
    meetings: { key: string; label: string; count: number }[];
    closed: { key: string; label: string; count: number }[];
    revenue: { key: string; label: string; count: number }[]; // count = EUR
  };
  /** Range-level sales rollups for the CAC/ROAS cards. CAC + ROAS are ads-only (spend is an ads-only
   *  cost — outbound has no cost tracking). Null = not computable yet (no closes / no revenue). */
  sales: { cac: number | null; roas: number | null; closedAds: number; revenueAds: number };
}

export function computeTotals(ads: AdPerf[], minResults: number): Totals {
  const t = ads.reduce(
    (s, a) => {
      s.spend += a.spend;
      s.impressions += a.impressions;
      s.clicks += a.clicks;
      s.linkClicks += a.linkClicks;
      s.leads += a.leads;
      return s;
    },
    { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0 }
  );
  const enoughLeads = t.leads >= minResults;
  return {
    ...t,
    cpl: enoughLeads && t.leads > 0 ? t.spend / t.leads : null,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
    convRate: enoughLeads && t.linkClicks > 0 ? (t.leads / t.linkClicks) * 100 : null,
  };
}

export async function getDashboard(opts: { from?: string; to?: string } = {}): Promise<Dashboard> {
  const sb = createAdminClient();

  // Effective settings = definition defaults with the tenant's overrides applied, so an admin's Settings
  // changes actually drive the ROI engine (target CPL, spend gate, window, thresholds) — not just the UI (C40).
  const tenantId = await getPrimaryTenantId();
  const [defsRes, overRes] = await Promise.all([
    sb.from("setting_definitions").select("key,default_value"),
    tenantId
      ? sb.from("tenant_settings").select("key,value").eq("tenant_id", tenantId)
      : Promise.resolve({ data: [] as { key: string; value: unknown }[], error: null }),
  ]);
  if (defsRes.error) throw defsRes.error;
  if (overRes.error) throw overRes.error;
  const settings: Settings = {};
  for (const r of defsRes.data!) settings[r.key] = r.default_value;
  for (const o of overRes.data ?? []) settings[o.key] = (o as { key: string; value: unknown }).value;

  // The account timezone anchors "today" and the default window. Meta buckets
  // insights in this tz, so a UTC "today" would drift the range by a day at the
  // midnight boundary and disagree with Ads Manager. Fetch it before the range math.
  const accountRes = await sb
    .from("ad_accounts")
    .select("fb_account_id,currency,timezone_name")
    .limit(1)
    .maybeSingle();
  if (accountRes.error) throw accountRes.error;
  const tz = accountRes.data?.timezone_name ?? null;
  const accountToday = todayInTz(tz);

  // The selected date range drives spend / leads / CTR / CPM / CPL. Validate the URL-supplied bounds
  // (fall back to defaults on anything malformed; clamp `to` to today; keep from <= to) so bad params
  // can never crash the page or produce NaN ranges (C43).
  const reachWindowDays = Number(settings.reporting_window_days ?? 30);
  let to = isYmd(opts.to) ? opts.to : accountToday;
  if (to > accountToday) to = accountToday;
  let from = isYmd(opts.from) ? opts.from : daysAgoInTz(tz, reachWindowDays - 1);
  if (from > to) from = to;
  const rangeDays = daysInclusive(from, to);

  // Weekly leads must bucket over COMPLETE Mon–Sun weeks (account timezone) so edge weeks aren't
  // under-counted by the range clip. Pull from the Monday of `from` through the Sunday of `to`,
  // but never into the future (the week containing "today" is in-progress → flagged partial below).
  const weekDataFrom = isoWeek(from);
  const lastWeekSunday = addDays(isoWeek(to), 6);
  const weekDataTo = lastWeekSunday < accountToday ? lastWeekSunday : accountToday;

  const targetCpl = Number(settings.target_cpl_eur ?? 10);
  const spendGate = Number(settings.d12_spend_gate_multiple ?? 4) * targetCpl;
  const minResults = Number(settings.small_sample_min_results ?? 5);
  const freqProspMax = Number(settings.d1_freq_prospecting_max ?? 1.3);
  const freqRetMin = Number(settings.d1_freq_retargeting_min ?? 2.0);
  const fatigueWin = Number(settings.d4_trailing_window_days ?? 7);
  const cpmWin = Number(settings.d8_baseline_window_days ?? 14);
  const cpmMinHistory = Number(settings.d8_min_history_days ?? 7);
  const cpmMinImprDay = Number(settings.d8_min_impressions_day ?? 500);

  const [adsRes, adsetsRes, campaignsRes, dailyData, winData, weekData, leadRowsData, meetingRowsData] = await Promise.all([
    sb.from("ads").select("id,name,status,adset_id,fb_ad_id,creative_thumb_url,creative_image_url").is("deleted_at", null),
    sb.from("adsets").select("id,campaign_id,name,status,fb_adset_id").is("deleted_at", null),
    sb.from("campaigns").select("id,name,status,fb_campaign_id").is("deleted_at", null),
    // Full-set (paginated) reads so growth past 1000 rows can't silently truncate the aggregates (C39).
    selectAllPaged<{ ad_id: string; date: string; spend: number | null; impressions: number | null; clicks: number | null; link_clicks: number | null; fb_leads: number | null; landing_page_views: number | null }>((s, e) =>
      sb
        .from("fb_insights_daily")
        .select("ad_id,date,spend,impressions,clicks,link_clicks,fb_leads,landing_page_views")
        .gte("date", from)
        .lte("date", to)
        .order("date", { ascending: true })
        .range(s, e)
    ),
    // Reach/frequency are a rolling-audience metric: read the latest synced window that ended on or
    // before the selected range end, so a historical range shows that period's frequency, not today's (C45).
    selectAllPaged<{ ad_id: string; reach: number | null; frequency: number | null; window_end: string }>((s, e) =>
      sb.from("fb_insights_window").select("ad_id,reach,frequency,window_end").lte("window_end", to).order("window_end", { ascending: false }).range(s, e)
    ),
    // Week-aligned daily rows for the weekly-leads chart (complete weeks, not clipped to the range).
    selectAllPaged<{ date: string; fb_leads: number | null; spend: number | null }>((s, e) =>
      sb.from("fb_insights_daily").select("date,fb_leads,spend").gte("date", weekDataFrom).lte("date", weekDataTo).range(s, e)
    ),
    // Every captured lead (any channel) — the all-channels KPI + speed-to-lead. Range-filtered in JS by
    // account-tz day so the boundary agrees with the Meta numbers above. Deliberately NOT part of any
    // spend/CPL math: outbound leads must never blur the ad metrics.
    selectAllPaged<{
      id: string;
      created_time: string | null;
      source: string | null;
      first_call_at: string | null;
      fb_ad_id: string | null;
      channel: string | null;
      opportunity_value: number | null;
      opportunity_status: string | null;
      opportunity_won_at: string | null;
      ghl_opportunity_id: string | null;
      ghl_contact_id: string | null;
    }>((s, e) =>
      sb
        .from("leads")
        .select("id,created_time,source,first_call_at,fb_ad_id,channel,opportunity_value,opportunity_status,opportunity_won_at,ghl_opportunity_id,ghl_contact_id")
        .is("deleted_at", null)
        .order("id")
        .range(s, e)
    ),
    // Every booked meeting — the meetings-by-source donut + the close signal (outcome=won). Joined to
    // the (non-deleted) leads above for its source bucket; range-filtered in JS by account-tz day.
    selectAllPaged<{ lead_id: string; starts_at: string | null; outcome: string | null; outcome_set_at: string | null }>((s, e) =>
      sb.from("lead_meetings").select("lead_id,starts_at,outcome,outcome_set_at").order("id").range(s, e)
    ),
  ]);
  if (adsRes.error) throw adsRes.error;
  if (adsetsRes.error) throw adsetsRes.error;
  if (campaignsRes.error) throw campaignsRes.error;

  // All-channel lead tallies + speed-to-lead (ad lead created → first call) + per-source donut
  // breakdowns, by account-tz day. One bucket function so every split agrees:
  // classify by ATTRIBUTION, not funnel (mirrors the Leads tab's isAdLead) — a landing-page lead that
  // arrived via an ad click (fb_ad_id / channel "Paid Ads") IS an ad lead; Meta counts it, so must we,
  // or the "ads" number here reads lower than the Meta-reported tile above for no real reason.
  const OUTBOUND_KEYS = new Set(["cold_call", "cold_email", "organic", "linkedin_dm"]);
  const sourceBucket = (l: { source: string | null; fb_ad_id: string | null; channel: string | null }): string => {
    const src = l.source ?? "instant_form";
    if (OUTBOUND_KEYS.has(src)) return src;
    if (src === "instant_form" || !!l.fb_ad_id || l.channel === "Paid Ads") return "ads";
    return "direct";
  };
  const SOURCE_LABELS: [string, string][] = [
    ["ads", "Ads"],
    ["cold_call", "Cold call"],
    ["cold_email", "Cold email"],
    ["organic", "Organic"],
    ["linkedin_dm", "LinkedIn DMs"],
    ["direct", "Direct"],
  ];
  const leadsBySource = new Map<string, number>(SOURCE_LABELS.map(([k]) => [k, 0]));
  const meetingsBySource = new Map<string, number>(SOURCE_LABELS.map(([k]) => [k, 0]));
  // Bucket for EVERY non-deleted lead (not range-clipped): a meeting inside the range can belong to a
  // lead created before it, and it still needs its source.
  const leadBucket = new Map<string, string>();
  let allLeadsTotal = 0;
  let allLeadsAds = 0;
  let allLeadsDirect = 0;
  let allLeadsOutbound = 0;
  const stl: number[] = [];
  for (const l of leadRowsData) {
    const bucket = sourceBucket(l);
    leadBucket.set(l.id, bucket);
    if (!l.created_time) continue;
    const day = dateInTz(l.created_time, tz ?? "UTC");
    if (day < from || day > to) continue;
    allLeadsTotal++;
    leadsBySource.set(bucket, (leadsBySource.get(bucket) ?? 0) + 1);
    if (OUTBOUND_KEYS.has(bucket)) {
      allLeadsOutbound++;
    } else if (bucket === "ads") {
      allLeadsAds++;
      // Speed-to-lead samples AD-ATTRIBUTED leads only — "how fast do we reply to paid leads"; a
      // cold-call lead's first dial is its creation, which would fake a 0-minute reply time.
      if (l.first_call_at) {
        const delta = new Date(l.first_call_at).getTime() - new Date(l.created_time).getTime();
        if (delta >= 0) stl.push(delta);
      }
    } else {
      allLeadsDirect++;
    }
  }
  stl.sort((a, b) => a - b);
  const speedToLeadMs = stl.length ? stl[Math.floor(stl.length / 2)] : null;

  // Meetings donut: every booking whose start day falls in the range, credited to its lead's source.
  // A meeting of a deleted lead has no bucket and is skipped (matches every other lead metric).
  // Along the way, collect each lead's close moment from a Won outcome (outcome_set_at = when the
  // operator ruled it; starts_at as a legacy fallback).
  const wonMeetingAt = new Map<string, string>();
  for (const m of meetingRowsData) {
    const bucket = leadBucket.get(m.lead_id);
    if (!bucket) continue;
    if (m.outcome === "won") {
      const at = m.outcome_set_at ?? m.starts_at;
      if (at && (!wonMeetingAt.has(m.lead_id) || at < wonMeetingAt.get(m.lead_id)!)) wonMeetingAt.set(m.lead_id, at);
    }
    if (!m.starts_at) continue;
    const day = dateInTz(m.starts_at, tz ?? "UTC");
    if (day < from || day > to) continue;
    meetingsBySource.set(bucket, (meetingsBySource.get(bucket) ?? 0) + 1);
  }

  // Closes + revenue, by the CLOSE day (not the lead's creation day — a June lead closed in July is a
  // July close). A lead is closed when a meeting was ruled Won (canonical, ours) OR its GHL opportunity
  // says won (a deal closed directly inside the CRM). One close per lead. Revenue = the lead's GHL
  // opportunity value (set from the dashboard, stored in GHL); a close with no value yet counts €0.
  const closedBySource = new Map<string, number>(SOURCE_LABELS.map(([k]) => [k, 0]));
  const revenueBySource = new Map<string, number>(SOURCE_LABELS.map(([k]) => [k, 0]));
  let closedAdsInRange = 0;
  let revenueAdsInRange = 0;
  // One close per DEAL, not per lead row: duplicate submissions share a GHL contact (that's what
  // duplicateCount exists for) and the sync mirrors the same opportunity onto every row — counting per
  // row would double the close and its revenue. Dedupe on the opportunity (else contact, else the row),
  // preferring rows whose close came from a Won meeting over opportunity-only ones (two passes).
  const seenDeals = new Set<string>();
  const countClose = (l: (typeof leadRowsData)[number], closeAt: string) => {
    const dealKey = l.ghl_opportunity_id ?? l.ghl_contact_id ?? l.id;
    if (seenDeals.has(dealKey)) return;
    const day = dateInTz(closeAt, tz ?? "UTC");
    if (day < from || day > to) {
      seenDeals.add(dealKey); // out-of-range close still claims the deal — a duplicate row must not re-date it into range
      return;
    }
    seenDeals.add(dealKey);
    const bucket = leadBucket.get(l.id)!;
    closedBySource.set(bucket, (closedBySource.get(bucket) ?? 0) + 1);
    const value = l.opportunity_value == null ? 0 : Number(l.opportunity_value);
    revenueBySource.set(bucket, (revenueBySource.get(bucket) ?? 0) + value);
    if (bucket === "ads") {
      closedAdsInRange++;
      revenueAdsInRange += value;
    }
  };
  for (const l of leadRowsData) {
    const at = wonMeetingAt.get(l.id);
    if (at) countClose(l, at); // pass 1: closes ruled Won on a meeting (canonical)
  }
  for (const l of leadRowsData) {
    if (wonMeetingAt.has(l.id)) continue;
    if (l.opportunity_status === "won" && l.opportunity_won_at) countClose(l, l.opportunity_won_at); // pass 2: closed directly in GHL
  }

  const adsetToCampaign = new Map<string, string>();
  const adsetInfo = new Map<string, { name: string; status: string; campaignId: string; fbId: string }>();
  for (const a of adsetsRes.data!) {
    adsetToCampaign.set(a.id, a.campaign_id);
    adsetInfo.set(a.id, { name: a.name ?? "Ad set", status: a.status ?? "", campaignId: a.campaign_id, fbId: a.fb_adset_id ?? "" });
  }
  const campaignInfo = new Map<string, { name: string; status: string; fbId: string }>();
  for (const c of campaignsRes.data!) campaignInfo.set(c.id, { name: c.name, status: c.status, fbId: c.fb_campaign_id ?? "" });

  // winRes is ordered window_end desc -> keep the latest window per ad.
  const winMap = new Map<string, { reach: number | null; frequency: number | null }>();
  for (const w of winData) if (!winMap.has(w.ad_id)) winMap.set(w.ad_id, { reach: w.reach, frequency: w.frequency });

  // Group daily rows per ad + accumulate landing-page views in one pass.
  const dailyByAd = new Map<string, DayPoint[]>();
  const lpvByAd = new Map<string, number>();
  for (const r of dailyData) {
    const impressions = Number(r.impressions ?? 0);
    const spend = Number(r.spend ?? 0);
    const clicks = Number(r.clicks ?? 0);
    const pt: DayPoint = {
      date: r.date,
      spend,
      impressions,
      clicks,
      linkClicks: Number(r.link_clicks ?? 0),
      leads: Number(r.fb_leads ?? 0),
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
      partial: r.date === accountToday,
    };
    const arr = dailyByAd.get(r.ad_id) ?? [];
    arr.push(pt);
    dailyByAd.set(r.ad_id, arr);
    lpvByAd.set(r.ad_id, (lpvByAd.get(r.ad_id) ?? 0) + Number(r.landing_page_views ?? 0));
  }

  type Pre = { ad: any; daily: DayPoint[]; spend: number; impressions: number; clicks: number; linkClicks: number; leads: number; lpViews: number };
  const pre: Pre[] = adsRes.data!.map((ad) => {
    const daily = (dailyByAd.get(ad.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const agg = daily.reduce(
      (s, d) => {
        s.spend += d.spend;
        s.impressions += d.impressions;
        s.clicks += d.clicks;
        s.linkClicks += d.linkClicks;
        s.leads += d.leads;
        return s;
      },
      { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0 }
    );
    return { ad, daily, ...agg, lpViews: lpvByAd.get(ad.id) ?? 0 };
  });

  const totalSpend = pre.reduce((s, p) => s + p.spend, 0) || 1;
  const ctrList = pre
    .filter((p) => p.impressions > 0)
    .map((p) => ({ id: p.ad.id, ctr: (p.clicks / p.impressions) * 100 }))
    .sort((a, b) => a.ctr - b.ctr);
  const ctrPct = new Map<string, number>();
  ctrList.forEach((x, i) => ctrPct.set(x.id, ctrList.length > 1 ? (i / (ctrList.length - 1)) * 100 : 50));

  const ads: AdPerf[] = pre
    .map((p) => {
      const w = winMap.get(p.ad.id) ?? { reach: null, frequency: null };
      const freq = w.frequency != null ? Number(w.frequency) : null;
      const gated = p.spend < spendGate;
      const cpl = p.leads > 0 ? p.spend / p.leads : null;
      const ctr = p.impressions > 0 ? (p.clicks / p.impressions) * 100 : null;
      const cpm = p.impressions > 0 ? (p.spend / p.impressions) * 1000 : null;
      const linkCtr = p.impressions > 0 ? (p.linkClicks / p.impressions) * 100 : null;
      const cpc = p.clicks > 0 ? p.spend / p.clicks : null;
      const spendSharePct = (p.spend / totalSpend) * 100;
      const campaignId = adsetToCampaign.get(p.ad.adset_id) ?? null;
      const campaignName = campaignId ? campaignInfo.get(campaignId)?.name ?? null : null;
      const adsetId = p.ad.adset_id ?? null;
      const adsetName = adsetId ? adsetInfo.get(adsetId)?.name ?? null : null;

      let freqBand: FreqBand | null = null;
      if (freq != null) freqBand = freq < freqProspMax ? "prospecting" : freq < freqRetMin ? "mid" : "retargeting";

      const latestDate = p.daily.length ? p.daily[p.daily.length - 1].date : null;
      const win = latestDate ? p.daily.filter((x) => x.date >= isoDaysBefore(latestDate, fatigueWin - 1)) : [];
      let ctrDeclinePct: number | null = null;
      const fatigueWindowImpressions = win.reduce((s, d) => s + d.impressions, 0);
      if (win.length >= 3) {
        const base = win.slice(0, -1);
        const baseImpr = base.reduce((s, d) => s + d.impressions, 0);
        const baseClicks = base.reduce((s, d) => s + d.clicks, 0);
        const baseCtr = baseImpr > 0 ? (baseClicks / baseImpr) * 100 : null;
        const last = win[win.length - 1];
        if (baseCtr && last.ctr != null) ctrDeclinePct = Math.max(0, ((baseCtr - last.ctr) / baseCtr) * 100);
      }

      const cpmWindow = (latestDate ? p.daily.filter((x) => x.date >= isoDaysBefore(latestDate, cpmWin - 1)) : []).filter(
        (d) => d.impressions >= cpmMinImprDay && d.cpm != null
      );
      let cpmSpikeRatio: number | null = null;
      if (cpmWindow.length >= cpmMinHistory) {
        const hist = cpmWindow.slice(0, -1).map((d) => d.cpm!) as number[];
        const med = median(hist);
        const last = cpmWindow[cpmWindow.length - 1].cpm!;
        if (med && med > 0) cpmSpikeRatio = last / med;
      }

      const flagInput: FlagInput = {
        spend: p.spend,
        frequency: freq,
        cpl,
        gated,
        spendSharePct,
        ctrPercentile: ctrPct.get(p.ad.id) ?? null,
        ctrDeclinePct,
        fatigueWindowImpressions,
        reachGrowthPct: null,
        cpmSpikeRatio,
      };

      return {
        id: p.ad.id,
        name: p.ad.name,
        status: p.ad.status,
        campaignId,
        campaignName,
        adsetId,
        adsetName,
        fbAdId: p.ad.fb_ad_id ?? "",
        fbAdsetId: adsetId ? adsetInfo.get(adsetId)?.fbId ?? null : null,
        thumb: p.ad.creative_thumb_url,
        imageUrl: p.ad.creative_image_url ?? p.ad.creative_thumb_url,
        spend: p.spend,
        impressions: p.impressions,
        clicks: p.clicks,
        linkClicks: p.linkClicks,
        leads: p.leads,
        lpViews: p.lpViews,
        reach: w.reach != null ? Number(w.reach) : null,
        frequency: freq,
        ctr,
        linkCtr,
        cpc,
        cpm,
        cpl: gated ? null : cpl,
        costPerResult: cpl,
        spendSharePct,
        gated,
        freqBand,
        flags: computeFlags(flagInput, settings),
        daily: p.daily,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const totals = computeTotals(ads, minResults);

  // Campaign summaries (date-scoped).
  const campMap = new Map<string, CampaignSummary>();
  for (const a of ads) {
    if (!a.campaignId) continue;
    const c =
      campMap.get(a.campaignId) ??
      ({
        id: a.campaignId,
        fbId: campaignInfo.get(a.campaignId)?.fbId ?? "",
        name: a.campaignName ?? "Campaign",
        status: campaignInfo.get(a.campaignId)?.status ?? "",
        spend: 0,
        leads: 0,
        impressions: 0,
        adCount: 0,
      } as CampaignSummary);
    c.spend += a.spend;
    c.leads += a.leads;
    c.impressions += a.impressions;
    c.adCount += 1;
    campMap.set(a.campaignId, c);
  }
  const campaigns = [...campMap.values()].sort((a, b) => b.spend - a.spend);

  // Ad set summaries (date-scoped metrics aggregated from their ads; all synced ad sets included).
  const adsetMap = new Map<string, AdSetSummary>();
  for (const [id, info] of adsetInfo) {
    adsetMap.set(id, {
      id, fbId: info.fbId, fbCampaignId: campaignInfo.get(info.campaignId)?.fbId ?? "",
      name: info.name, status: info.status, campaignId: info.campaignId,
      spend: 0, leads: 0, impressions: 0, adCount: 0, cpl: null,
    });
  }
  for (const a of ads) {
    if (!a.adsetId) continue;
    const s = adsetMap.get(a.adsetId);
    if (!s) continue;
    s.spend += a.spend;
    s.leads += a.leads;
    s.impressions += a.impressions;
    s.adCount += 1;
  }
  const adsets: AdSetSummary[] = [...adsetMap.values()].map((s) => ({
    ...s,
    cpl: s.leads > 0 ? s.spend / s.leads : null,
  }));

  // Time-series for charts.
  const dayMap = new Map<string, TimePoint>();
  for (const r of dailyData) {
    const p = dayMap.get(r.date) ?? { date: r.date, spend: 0, leads: 0, impressions: 0, partial: r.date === accountToday };
    p.spend += Number(r.spend ?? 0);
    p.leads += Number(r.fb_leads ?? 0);
    p.impressions += Number(r.impressions ?? 0);
    dayMap.set(r.date, p);
  }
  // Continuous daily series: include zero-spend days so the chart shows gaps as empty bars.
  const daily: TimePoint[] = [];
  for (let i = 0; i < rangeDays; i++) {
    const date = isoDaysBefore(to, rangeDays - 1 - i);
    daily.push(dayMap.get(date) ?? { date, spend: 0, leads: 0, impressions: 0, partial: date === accountToday });
  }
  // Sum complete-week leads/spend, then build a CONTINUOUS series: every Mon–Sun week across the
  // SAME range as the daily chart, zero-filled — so weeks with no leads still show (e.g. 0 → 2 trend).
  const currentWeek = isoWeek(accountToday);
  const weekSums = new Map<string, { leads: number; spend: number }>();
  for (const r of weekData) {
    const wk = isoWeek(r.date);
    const s = weekSums.get(wk) ?? { leads: 0, spend: 0 };
    s.leads += Number(r.fb_leads ?? 0);
    s.spend += Number(r.spend ?? 0);
    weekSums.set(wk, s);
  }
  const weekly: WeekPoint[] = [];
  const lastWeekMonday = isoWeek(to);
  for (let wk = isoWeek(from); wk <= lastWeekMonday; wk = addDays(wk, 7)) {
    const s = weekSums.get(wk) ?? { leads: 0, spend: 0 };
    weekly.push({ week: wk, leads: s.leads, spend: s.spend, partial: wk === currentWeek });
  }

  const topCreatives = [...ads]
    .filter((a) => !a.gated && a.costPerResult != null)
    .sort((a, b) => a.costPerResult! - b.costPerResult!)
    .slice(0, 5);

  return {
    account: accountRes.data ?? null,
    range: { from, to, days: rangeDays },
    accountToday,
    reachWindowDays,
    settings,
    targetCpl,
    spendGate,
    minResults,
    totals,
    ads,
    campaigns,
    adsets,
    allGated: ads.length > 0 && ads.every((a) => a.gated),
    daily,
    weekly,
    topCreatives,
    funnelLeads: totals.leads,
    allChannelLeads: { total: allLeadsTotal, ads: allLeadsAds, outbound: allLeadsOutbound, direct: allLeadsDirect },
    speedToLead: { medianMs: speedToLeadMs, sampled: stl.length },
    bySource: {
      leads: SOURCE_LABELS.map(([key, label]) => ({ key, label, count: leadsBySource.get(key) ?? 0 })),
      meetings: SOURCE_LABELS.map(([key, label]) => ({ key, label, count: meetingsBySource.get(key) ?? 0 })),
      closed: SOURCE_LABELS.map(([key, label]) => ({ key, label, count: closedBySource.get(key) ?? 0 })),
      revenue: SOURCE_LABELS.map(([key, label]) => ({ key, label, count: revenueBySource.get(key) ?? 0 })),
    },
    sales: {
      cac: closedAdsInRange > 0 ? totals.spend / closedAdsInRange : null,
      roas: totals.spend > 0 && revenueAdsInRange > 0 ? revenueAdsInRange / totals.spend : null,
      closedAds: closedAdsInRange,
      revenueAds: revenueAdsInRange,
    },
  };
}
