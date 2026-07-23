/**
 * Ad Launcher — bulk CREATE on Meta. Everything is created **PAUSED**, always.
 * This module never sets a status to ACTIVE; activation is a separate, user-only action.
 *
 * No `server-only` guard on purpose: the same launch logic runs from the API route
 * (createAdminClient) and from a throwaway test harness (a directly-built client).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { uploadAdImage, createAdCreative, createCarouselCreative, createFlexibleCreative, createVideoCreative, createCampaign, createAdSet, createAd, createLeadForm, deleteObject, updateObject, getAccountPixelId } from "./meta-ads";
import { metaGet, metaGetAll, uploadAdVideo, pageId, instagramActorId } from "./meta";
import { buildPositions, PLACEMENT_GROUPS, type PlacementGroups } from "./placements";
import { normalizeGreeting } from "./leadform";
import { getUrlSettings } from "./settings";

export type LaunchFormat = "single" | "multi_ratio" | "flexible" | "carousel";

export type LaunchAdInput = {
  name: string;
  format: LaunchFormat;
  primaryText: string[];
  headline: string[];
  description: string[];
  link: string;
  cta: string;
  leadFormId: string | null; // a lead_form_templates.id (resolved to a Meta form id)
  afterSubmitUrl?: string; // form ads only: the audience's destination URL → baked into the form's completion screen
  enhancements: boolean;
  utm?: string; // optional UTM query string appended to the destination link
  adSetIds: string[];
  audienceIds?: string[]; // "Launch New": which audiences this ad goes into (empty/undefined = all)
  images: string[]; // base64 file bytes (no data: prefix), one per creative — "" for a pre-uploaded video
  kinds?: ("image" | "video")[]; // parallel to images; defaults to "image"
  ratios?: string[]; // parallel to images; aspect-ratio label (e.g. "9:16","1:1") — used for Multi-Ratio placement mapping
  videoIds?: (string | null)[]; // parallel to images; a pre-uploaded Meta video_id for video creatives (large-video path)
  imageHashes?: (string | null)[]; // parallel to images; a pre-uploaded Meta image hash — when set, the base64 is skipped (keeps the launch payload tiny)
  imageCrops?: Record<string, number[][]>; // Meta image_crops (per-ratio pixel rects) from the per-ad "Frame for Feed" tool — single-image ads only
};

export type LaunchResult = {
  created: { adId: string; creativeId: string; adSetId: string; name: string }[];
  errors: { name: string; adSetId: string | null; error: string }[];
};

/**
 * One audience inside a "Launch New" batch — becomes its own PAUSED ad set. `id` matches the
 * AdRow.audienceIds the client sends; `name` is the ad-set name. Destination "site" makes the ad
 * set optimize for landing-page conversions (the account pixel's "Lead" event) instead of an instant form.
 */
export type AudienceConfig = {
  id: string;
  name: string;
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  genders?: number[] | null;
  advantageAudience?: boolean;
  facebook?: boolean;
  instagram?: boolean;
  placements?: string[];
  optimizationGoal?: string;
  attributionDays?: number;
  destination?: "form" | "site";
  landingUrl?: string;
};

export type NewAdSetConfig = {
  campaignName: string;
  dailyBudgetEur: number;
  campaignMode?: "existing" | "new"; // default "new" — where the new ad set(s) live
  campaignId?: string; // when campaignMode === "existing": attach the new ad set to this campaign
  adSetName?: string; // auto-named from the audience; falls back to "<campaign> — ad set"
  budgetMode?: "cbo" | "abo"; // default "cbo" — campaign-level budget vs per-ad-set budget (new campaign only)
  // "One ad set per folder" launch: all audiences are plain single-image buckets sharing one destination.
  // Lets the create route build the campaign + all ad sets up front and drain the ads in paced batches.
  structured?: boolean;
  // Multi-audience: one ad set per audience. When omitted, the single top-level audience below is used.
  audiences?: AudienceConfig[];
  // Targeting + ad-set settings (all optional — the defaults reproduce the proven locked setup).
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  genders?: number[] | null; // [1]=men, [2]=women; null/empty = all
  advantageAudience?: boolean;
  facebook?: boolean;
  instagram?: boolean;
  placements?: string[]; // PlacementKey[]; empty/undefined = automatic (all positions)
  optimizationGoal?: string; // default LEAD_GENERATION
  attributionDays?: number; // click-through window; default 1
  scheduleStart?: string; // ISO; optional ad-set start
  scheduleEnd?: string; // ISO; optional ad-set end
};

const attributionSpecFor = (days?: number) => [{ event_type: "CLICK_THROUGH", window_days: days && days > 0 ? days : 1 }];

/**
 * Targeting for a freshly-created ad set, built from the launch settings. Defaults reproduce the
 * proven locked preset (PT, 29-65, FB+IG, Advantage-off, automatic placements). Manual placement
 * groups are applied only when the user chooses them; otherwise placements stay automatic (all).
 */
function buildTargeting(cfg: NewAdSetConfig): Record<string, any> {
  const ageMin = Math.max(13, Math.min(65, cfg.ageMin ?? 29));
  const ageMax = Math.max(ageMin, Math.min(65, cfg.ageMax ?? 65));
  const fb = cfg.facebook !== false;
  const ig = cfg.instagram !== false;
  const platforms = [fb ? "facebook" : null, ig ? "instagram" : null].filter(Boolean) as string[];
  const t: Record<string, any> = {
    age_min: ageMin,
    age_max: ageMax,
    geo_locations: { countries: cfg.countries?.length ? cfg.countries : ["PT"], location_types: ["home", "recent"] },
    targeting_automation: { advantage_audience: cfg.advantageAudience ? 1 : 0 },
    publisher_platforms: platforms.length ? platforms : ["facebook", "instagram"],
    device_platforms: ["mobile", "desktop"],
    brand_safety_content_filter_levels: ["FACEBOOK_RELAXED"],
  };
  if (cfg.genders && cfg.genders.length) t.genders = cfg.genders;
  if (cfg.placements?.length) {
    const groups = Object.fromEntries(PLACEMENT_GROUPS.map((g) => [g.key, cfg.placements!.includes(g.key)])) as PlacementGroups;
    const pos = buildPositions(groups, fb, ig);
    if (pos.facebook_positions) t.facebook_positions = pos.facebook_positions;
    if (pos.instagram_positions) t.instagram_positions = pos.instagram_positions;
    // Keep publisher_platforms consistent with the chosen positions: e.g. Instagram enabled + only the
    // FB-only "In-stream" group leaves IG in publisher_platforms with no instagram_positions — incoherent
    // targeting Meta may reject or mis-deliver. Drop any platform that ended up with no positions (N-meta-0).
    const effective = [
      fb && pos.facebook_positions?.length ? "facebook" : null,
      ig && pos.instagram_positions?.length ? "instagram" : null,
    ].filter(Boolean) as string[];
    if (effective.length) t.publisher_platforms = effective;
  }
  return t;
}

/** Append a UTM query string to a destination link (no-op when empty). */
function withUtm(link: string, utm?: string): string {
  const u = (utm || "").trim().replace(/^[?&]+/, "");
  if (!u) return link;
  return link + (link.includes("?") ? "&" : "?") + u;
}

const countNonEmpty = (xs: string[]) => (Array.isArray(xs) ? xs.map((s) => (s || "").trim()).filter(Boolean).length : 0);
const hasMultiVariations = (ad: LaunchAdInput) =>
  countNonEmpty(ad.primaryText) > 1 || countNonEmpty(ad.headline) > 1 || countNonEmpty(ad.description) > 1;

/**
 * Whether an ad must be built as an asset-feed (Dynamic Creative) ad — which requires a dedicated
 * is_dynamic_creative ad set holding it alone. True for Flexible/Multi-Ratio always, and for a
 * single IMAGE ad carrying multiple copy variations (only when launching into a fresh ad set, i.e.
 * Launch New — an existing regular ad set can't hold a dynamic-creative ad, so there we keep the first).
 */
function usesAssetFeed(ad: LaunchAdInput, launchingNew: boolean): boolean {
  if (ad.format === "flexible" || ad.format === "multi_ratio") return true;
  if (ad.format === "single" && launchingNew && (ad.kinds?.[0] ?? "image") !== "video") return hasMultiVariations(ad);
  return false;
}

/**
 * Explicit Advantage+ creative spec for EVERY creative (asset-feed and basic). Meta auto-applies
 * enhancement defaults when none is sent, so we always send an explicit spec to make the user's
 * Enhancements toggle deterministic both ways (ON → OPT_IN, OFF → OPT_OUT).
 *
 * `adapt_to_placement` (placement auto-fit) is ALWAYS on, independent of the other enhancements: it's
 * what makes one image fit every placement — e.g. a 9:16 Story creative is cropped to a centered 4:5 on
 * Feed. Without it, a vertical image gets letterboxed / awkwardly cropped on Feed. It only re-frames the
 * image to each placement's ratio; it does NOT do the AI text/image touch-ups (those stay on the toggle).
 */
function assetFeedFeatures(ad: LaunchAdInput): Record<string, any> {
  const on = !!ad.enhancements;
  const s = (v: boolean) => ({ enroll_status: v ? "OPT_IN" : "OPT_OUT" });
  return {
    creative_features_spec: {
      image_touchups: s(on),
      text_optimizations: s(on),
      inline_comment: s(on),
      // Fit-to-placement is on by default (a 9:16 → 4:5 on Feed). But when the ad carries an explicit
      // "Frame for Feed" crop, turn it OFF so Meta uses OUR exact image_crops instead of choosing its own.
      adapt_to_placement: s(!ad.imageCrops),
    },
  };
}

// True Multi-Ratio uses MANUAL placements so asset_customization_rules can partition them by shape:
// the tall image → Stories/Reels, the feed image → Feeds, the landscape image → right column/search.
const MR_FEED = { facebook_positions: ["feed", "profile_feed", "marketplace"], instagram_positions: ["stream", "profile_feed"] };
const MR_VERTICAL = { facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] };
const MR_WIDE = { facebook_positions: ["right_hand_column", "search"] }; // FB-only landscape placements
const MR_PLATFORMS = ["facebook", "instagram"];

/**
 * Targeting for a Multi-Ratio ad set: the chosen audience + the manual placements the customization
 * rules map. Multi-Ratio always uses both platforms and its own placements (its whole purpose), but
 * still honors the audience's age/geo/gender/Advantage settings.
 */
function multiRatioTargeting(cfg: NewAdSetConfig): Record<string, any> {
  const base = buildTargeting({ ...cfg, facebook: true, instagram: true, placements: [] });
  return {
    ...base,
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions: [...MR_FEED.facebook_positions, ...MR_VERTICAL.facebook_positions, ...MR_WIDE.facebook_positions],
    instagram_positions: [...MR_FEED.instagram_positions, ...MR_VERTICAL.instagram_positions],
  };
}

const RATIO_NUM: Record<string, number> = { "9:16": 0.5625, "4:5": 0.8, "1:1": 1, "1.91:1": 1.91, "16:9": 1.778 };
const ratioNum = (label: string) => RATIO_NUM[label] ?? 1;

/**
 * Choose the best image index per placement shape: vert (most portrait → Stories/Reels), feed (closest
 * to 4:5, Meta's recommended feed ratio → Feeds), wide (most landscape → right column/search). Returns
 * null when every image is the same orientation (nothing to map → plain asset feed fallback).
 */
function multiRatioBuckets(ratios: string[]): { vert: number; feed: number; wide: number } | null {
  if (ratios.length < 2) return null;
  let vert = 0;
  let feed = 0;
  let wide = 0;
  for (let i = 1; i < ratios.length; i++) {
    if (ratioNum(ratios[i]) < ratioNum(ratios[vert])) vert = i; // most portrait
    if (Math.abs(ratioNum(ratios[i]) - 0.8) < Math.abs(ratioNum(ratios[feed]) - 0.8)) feed = i; // closest to 4:5
    if (ratioNum(ratios[i]) > ratioNum(ratios[wide])) wide = i; // most landscape
  }
  if (vert === feed && feed === wide) return null;
  return { vert, feed, wide };
}

/**
 * Plan a TRUE Multi-Ratio (placement asset customization) creative: map each placement shape to its
 * best-fitting image via asset_customization_rules. Distinct images are deduped + labelled; buckets
 * that resolve to the same image just share its label. Returns null when there's nothing to map.
 */
function planMultiRatio(ratios: string[] | undefined, hashes: string[]): { hashes: string[]; labels: string[]; rules: any[] } | null {
  if (!ratios || hashes.length < 2 || ratios.length !== hashes.length) return null;
  const b = multiRatioBuckets(ratios);
  if (!b) return null;
  const label = (i: number) => `img${i}`;
  const used = Array.from(new Set([b.vert, b.feed, b.wide]));
  return {
    hashes: used.map((i) => hashes[i]),
    labels: used.map(label),
    rules: [
      { customization_spec: { publisher_platforms: MR_PLATFORMS, ...MR_VERTICAL }, image_label: { name: label(b.vert) } },
      { customization_spec: { publisher_platforms: MR_PLATFORMS, ...MR_FEED }, image_label: { name: label(b.feed) } },
      { customization_spec: { publisher_platforms: ["facebook"], ...MR_WIDE }, image_label: { name: label(b.wide) } },
    ],
  };
}

/**
 * Will this Multi-Ratio row actually use placement asset customization? Mirrors planMultiRatio on the
 * raw (pre-upload) images so prepareNewAdSets can pick the right ad-set type: a customized creative is
 * NOT a Dynamic Creative — it needs a REGULAR ad set — while the plain-asset-feed fallback needs a dynamic one.
 */
function willCustomizeMultiRatio(ad: LaunchAdInput): boolean {
  if (ad.format !== "multi_ratio") return false;
  const ratios = (ad.ratios ?? []).filter((_, i) => ad.images[i] && ad.images[i].length);
  return multiRatioBuckets(ratios) !== null;
}

/** Turn one audience into the subset of NewAdSetConfig fields buildTargeting()/multiRatioTargeting() read. */
function audienceCfg(cfg: NewAdSetConfig, a: AudienceConfig): NewAdSetConfig {
  return {
    ...cfg,
    countries: a.countries,
    ageMin: a.ageMin,
    ageMax: a.ageMax,
    genders: a.genders ?? null,
    advantageAudience: a.advantageAudience,
    facebook: a.facebook,
    instagram: a.instagram,
    placements: a.placements,
    optimizationGoal: a.optimizationGoal,
    attributionDays: a.attributionDays,
  };
}

/** The single top-level audience, as a one-item list — back-compat for callers that don't send `audiences`. */
function audiencesOf(cfg: NewAdSetConfig): AudienceConfig[] {
  if (cfg.audiences && cfg.audiences.length) return cfg.audiences;
  return [
    {
      id: "default",
      name: (cfg.adSetName || "").trim() || `${cfg.campaignName} — ad set`,
      countries: cfg.countries,
      ageMin: cfg.ageMin,
      ageMax: cfg.ageMax,
      genders: cfg.genders ?? null,
      advantageAudience: cfg.advantageAudience,
      facebook: cfg.facebook,
      instagram: cfg.instagram,
      placements: cfg.placements,
      optimizationGoal: cfg.optimizationGoal,
      attributionDays: cfg.attributionDays,
      destination: "form",
      landingUrl: "",
    },
  ];
}

/** Delivery config cloned from an existing campaign's ad set when we attach a new ad set to it. */
type ExistingDelivery = {
  optimizationGoal: string;
  billingEvent: string;
  destinationType?: string;
  promotedObject?: Record<string, any>;
  attributionSpec?: Array<Record<string, any>>;
  isSite: boolean; // optimizes for a landing-page conversion (vs an on-ad instant form)
};

// Keep only the writable keys of a promoted_object — echoing the raw read back pulls read-only bits Meta rejects.
function clonePromotedObject(po: any): Record<string, any> | undefined {
  if (!po || typeof po !== "object") return undefined;
  const out: Record<string, any> = {};
  for (const k of ["page_id", "pixel_id", "custom_event_type", "custom_conversion_id", "application_id", "object_store_url", "product_catalog_id", "offer_id", "smart_pse_enabled"]) {
    if (po[k] != null) out[k] = po[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Read the ad-delivery config of a campaign we're attaching a NEW ad set to. Meta requires every ad set in a
 * CBO ("lowest cost") campaign to share the SAME optimization for ad delivery, down to the promoted_object
 * (incl. `smart_pse_enabled`) — otherwise it rejects the new ad set with "The same optimization for ad
 * delivery selection is required…". So we clone an existing ad set's delivery. Returns the CBO flag (campaign
 * carries the budget) and a reference to clone (null for an empty campaign → fall back to our defaults).
 */
async function getExistingCampaignDelivery(campaignId: string): Promise<{ isCbo: boolean; campaignName: string | null; ref: ExistingDelivery | null }> {
  let isCbo = false;
  let campaignName: string | null = null;
  // If we can't read the campaign at all, ABORT rather than silently assuming ABO — mis-classifying a CBO
  // campaign as ABO skips the delivery guard/clone and gets the new ad set rejected by Meta (100/1885760) (C22).
  const camp = await metaGet<any>(campaignId, { fields: "name,daily_budget,lifetime_budget" }).catch((e: any) => {
    throw new Error(`Couldn't read the selected campaign — try again. (${e?.message || "Meta read failed"})`);
  });
  isCbo = Number(camp?.daily_budget) > 0 || Number(camp?.lifetime_budget) > 0;
  campaignName = camp?.name || null;
  let ref: ExistingDelivery | null = null;
  try {
    // Paginate so a campaign whose first ad sets are all dynamic-creative still finds a plain template (C22).
    const rows: any[] = await metaGetAll<any>(`${campaignId}/adsets`, {
      fields: "optimization_goal,billing_event,destination_type,promoted_object,attribution_spec,is_dynamic_creative",
      limit: "50",
    });
    // Prefer a plain (non-dynamic-creative) ad set as the template; fall back to any ad set with an optimization.
    const pick = rows.find((s) => s?.optimization_goal && !s?.is_dynamic_creative) ?? rows.find((s) => s?.optimization_goal);
    if (pick) {
      ref = {
        optimizationGoal: pick.optimization_goal,
        billingEvent: pick.billing_event || "IMPRESSIONS",
        destinationType: pick.destination_type,
        promotedObject: clonePromotedObject(pick.promoted_object),
        attributionSpec: Array.isArray(pick.attribution_spec) ? pick.attribution_spec : undefined,
        isSite: pick.optimization_goal === "OFFSITE_CONVERSIONS" || pick.destination_type === "WEBSITE",
      };
    }
  } catch {
    /* empty/unreadable campaign — the new ad set uses our defaults */
  }
  return { isCbo, campaignName, ref };
}

/**
 * "Launch New": create a fresh PAUSED campaign + one ad set per audience, and assign the ads across
 * them (AdRow.audienceIds; empty = every audience). Asset-feed ads (Flexible/Multi-Ratio, or a single
 * image with multiple copy variations) each get their own dedicated dynamic-creative ad set per audience;
 * plain single/carousel ads share one regular ad set per audience.
 *
 * Destination is per audience: "form" → instant lead form (ON_AD + page promoted object); "site" →
 * landing-page conversions (WEBSITE + pixel "Lead" event), where the creative links to the landing URL
 * and carries no form. An ad spanning both kinds gets one creative per destination (the work items below).
 */
/**
 * Shared "Launch New" setup: resolve audiences, (existing-campaign) delivery, budget mode + pixel, create or
 * attach the campaign, and hand back the per-audience ad-set factory. Used by prepareNewAdSets (creates ad
 * sets lazily per ad) and createLaunchStructure (creates all ad sets up front, no ads).
 */
async function prepareCampaign(cfg: NewAdSetConfig): Promise<{
  campaignId: string;
  createdCampaignId: string | null;
  audiences: AudienceConfig[];
  audById: Map<string, AudienceConfig>;
  isSiteFor: (a: AudienceConfig) => boolean;
  mkAdSet: (name: string, dyn: boolean, targeting: Record<string, any>, a: AudienceConfig) => Promise<{ id: string }>;
}> {
  // Attach the new ad set(s) to an existing campaign, or mint a fresh one. Only a campaign WE create
  // gets cleaned up on failure (never an existing one the user picked).
  const audiences = audiencesOf(cfg);
  const audById = new Map(audiences.map((a) => [a.id, a]));

  // Attaching to an existing campaign? Read its delivery config. Meta rejects an ad set whose optimization
  // differs from the campaign's other ad sets under CBO ("lowest cost" / shared campaign budget).
  const existingMode = cfg.campaignMode === "existing" && !!cfg.campaignId;
  let refDelivery: ExistingDelivery | null = null;
  let forceCbo = false;
  let campaignName = cfg.campaignName || "that campaign";
  if (existingMode) {
    const info = await getExistingCampaignDelivery(cfg.campaignId!);
    refDelivery = info.ref;
    forceCbo = info.isCbo;
    if (info.campaignName) campaignName = info.campaignName;
  }
  // CBO = budget on the campaign (Meta splits it). ABO = budget on each ad set. An existing CBO campaign
  // forces CBO regardless of the client's pick (an ad-set-level budget there is rejected).
  const abo = forceCbo ? false : cfg.budgetMode === "abo";

  // A CBO campaign forces every ad set onto ONE optimization. If the audience's destination (landing page
  // vs instant form) can't match the campaign's, we can't launch it here — say so clearly rather than
  // silently mangling the ads. When it DOES match, `cboClone` coerces the exact optimization to the
  // campaign's so Meta accepts it. (An ABO campaign allows mixed optimizations — no coercion needed.)
  if (existingMode && forceCbo) {
    for (const a of audiences) {
      if (!refDelivery) throw new Error(`Couldn't read "${campaignName}"'s setup to match it (it uses a shared budget). Try again, or launch these into a new campaign.`);
      if ((a.destination === "site") !== refDelivery.isSite) {
        const campGoal = refDelivery.isSite ? "website conversions" : "instant-form leads";
        const adGoal = a.destination === "site" ? "a landing page" : "an instant form";
        throw new Error(
          `These ads send people to ${adGoal}, but "${campaignName}" optimizes for ${campGoal}. A shared-budget (CBO) campaign needs every ad set on the same goal — launch these into a new campaign, or switch the destination to match.`
        );
      }
    }
  }
  const cboClone = existingMode && forceCbo && refDelivery ? refDelivery : null;

  // Whether an audience effectively sends to a landing page (under CBO coercion it's the campaign's kind).
  const isSiteFor = (a: AudienceConfig) => (cboClone ? cboClone.isSite : a.destination === "site");

  // Resolve the account pixel once — only if we'll create a landing-page (conversion) ad set and don't
  // already inherit a pixel from the existing campaign.
  let pixelId: string | null = null;
  const needPixel = cboClone ? cboClone.isSite && !cboClone.promotedObject?.pixel_id : audiences.some((a) => a.destination === "site");
  if (needPixel) {
    pixelId = await getAccountPixelId();
    if (!pixelId) throw new Error("No Meta Pixel found on the ad account — connect a pixel to launch landing-page (conversion) ad sets.");
  }

  let createdCampaignId: string | null = null;
  let campaignId: string;
  if (cfg.campaignMode === "existing" && cfg.campaignId) {
    campaignId = cfg.campaignId;
  } else {
    const campaign = await createCampaign({
      name: cfg.campaignName,
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetEur: abo ? undefined : cfg.dailyBudgetEur, // CBO only: budget on the campaign
      adsetBudgetSharing: abo ? false : undefined, // ABO: Meta requires this set explicitly
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    });
    campaignId = campaign.id;
    createdCampaignId = campaign.id;
  }

  // Per-audience ad-set delivery wiring. In existing-campaign mode we CLONE the campaign's existing delivery
  // (optimization/billing/destination/promoted_object, incl. smart_pse_enabled) so a CBO campaign accepts the
  // new ad set; otherwise it's the audience's own instant-form vs landing-page choice.
  const destFor = (a: AudienceConfig): { destinationType?: string; optimizationGoal: string; promotedObject: Record<string, any>; billingEvent: string; attributionSpec?: Array<Record<string, any>> } => {
    if (cboClone) {
      return {
        destinationType: cboClone.destinationType,
        optimizationGoal: cboClone.optimizationGoal,
        promotedObject: cboClone.promotedObject ?? (cboClone.isSite ? { pixel_id: pixelId!, custom_event_type: "LEAD" } : { page_id: pageId() }),
        billingEvent: cboClone.billingEvent,
        attributionSpec: cboClone.attributionSpec,
      };
    }
    return a.destination === "site"
      ? { destinationType: "WEBSITE", optimizationGoal: "OFFSITE_CONVERSIONS", promotedObject: { pixel_id: pixelId!, custom_event_type: "LEAD" }, billingEvent: "IMPRESSIONS" }
      : { destinationType: "ON_AD", optimizationGoal: a.optimizationGoal || "LEAD_GENERATION", promotedObject: { page_id: pageId() }, billingEvent: "IMPRESSIONS" };
  };
  const mkAdSet = (name: string, dyn: boolean, targeting: Record<string, any>, a: AudienceConfig) => {
    const d = destFor(a);
    return createAdSet({
      name: name.slice(0, 100),
      campaignId,
      billingEvent: d.billingEvent || "IMPRESSIONS",
      attributionSpec: d.attributionSpec ?? attributionSpecFor(a.attributionDays),
      targeting,
      status: "PAUSED",
      isDynamicCreative: dyn,
      dailyBudgetEur: abo ? cfg.dailyBudgetEur : undefined, // ABO only: budget per ad set
      // Meta requires a start time on a budgeted (ABO) ad set with no campaign schedule.
      startTime: cfg.scheduleStart || (abo ? new Date().toISOString() : undefined),
      endTime: cfg.scheduleEnd || undefined,
      destinationType: d.destinationType,
      optimizationGoal: d.optimizationGoal,
      promotedObject: d.promotedObject,
    });
  };

  return { campaignId, createdCampaignId, audiences, audById, isSiteFor, mkAdSet };
}

async function prepareNewAdSets(ads: LaunchAdInput[], cfg: NewAdSetConfig): Promise<LaunchAdInput[]> {
  const { createdCampaignId, audiences, audById, isSiteFor, mkAdSet } = await prepareCampaign(cfg);

  try {
    const sharedByAud = new Map<string, string>(); // audienceId → shared regular ad-set id (plain ads)
    const out: LaunchAdInput[] = [];
    for (const ad of ads) {
      // Which audiences this ad runs in (empty/invalid → all). One ad set gets created per audience.
      const wanted = (ad.audienceIds ?? []).filter((id) => audById.has(id));
      const list = (wanted.length ? wanted : audiences.map((a) => a.id)).map((id) => audById.get(id)!);

      // Build/locate each audience's ad set, grouping the resulting ids by destination so the creative
      // (form vs website link) is built once per kind.
      type Group = { site: boolean; landingUrl: string; adSetIds: string[] };
      const groups = new Map<string, Group>();
      for (const a of list) {
        const acfg = audienceCfg(cfg, a);
        let adSetId: string;
        if (ad.format === "multi_ratio") {
          const customize = willCustomizeMultiRatio(ad);
          adSetId = (await mkAdSet(`${a.name} · ${ad.name}`, !customize, multiRatioTargeting(acfg), a)).id;
        } else if (usesAssetFeed(ad, true)) {
          adSetId = (await mkAdSet(`${a.name} · ${ad.name}`, true, buildTargeting(acfg), a)).id;
        } else {
          let shared = sharedByAud.get(a.id);
          if (!shared) {
            shared = (await mkAdSet(a.name, false, buildTargeting(acfg), a)).id;
            sharedByAud.set(a.id, shared);
          }
          adSetId = shared;
        }
        const site = isSiteFor(a);
        const url = (a.landingUrl || "").trim();
        // Group by destination AND url so each distinct landing page / after-submit redirect gets its own creative+form.
        const key = site ? `site:${url}` : `form:${url}`;
        const g = groups.get(key) ?? { site, landingUrl: url, adSetIds: [] };
        g.adSetIds.push(adSetId);
        groups.set(key, g);
      }

      // One work item per destination group → launchAds builds the matching creative for each.
      for (const g of groups.values()) {
        if (g.site) out.push({ ...ad, adSetIds: g.adSetIds, link: g.landingUrl || ad.link, leadFormId: null });
        else out.push({ ...ad, adSetIds: g.adSetIds, afterSubmitUrl: g.landingUrl });
      }
    }
    return out;
  } catch (e) {
    // Only remove a campaign WE created on failure — never an existing one the user picked.
    if (createdCampaignId) await deleteObject(createdCampaignId).catch(() => {});
    throw e;
  }
}

/**
 * Create ONLY the campaign + one plain ad set per audience (no ads), paced. Returns the campaign id and a
 * map audienceId → adSetId, so a large "one ad set per folder" launch can build the whole structure up front
 * and then drain the ads into those ad sets across paced background batches (existing-ad-set mode) — keeping
 * each burst under Meta's Development-tier rate cap. Every audience must be a plain (non-asset-feed) bucket;
 * the caller guarantees that (all rows are single-image, no copy variations).
 */
export async function createLaunchStructure(cfg: NewAdSetConfig): Promise<{ campaignId: string; adSetByAudience: Record<string, string> }> {
  const { campaignId, createdCampaignId, audiences, mkAdSet } = await prepareCampaign(cfg);
  try {
    const adSetByAudience: Record<string, string> = {};
    for (let i = 0; i < audiences.length; i++) {
      const a = audiences[i];
      adSetByAudience[a.id] = (await mkAdSet(a.name, false, buildTargeting(audienceCfg(cfg, a)), a)).id;
      if (i < audiences.length - 1) await sleep(1500); // pace ad-set creation so the burst can't trip code 17
    }
    return { campaignId, adSetByAudience };
  } catch (e) {
    // Roll back a campaign WE created if the ad sets couldn't all be built.
    if (createdCampaignId) await deleteObject(createdCampaignId).catch(() => {});
    throw e;
  }
}

/**
 * Create ONE regular PAUSED ad set (in an existing or new campaign), targeting from the config.
 * Used when DUPLICATING ads into a brand-new ad set (the copies share it).
 */
export async function createOneAdSet(cfg: NewAdSetConfig): Promise<string> {
  const abo = cfg.budgetMode === "abo";
  let campaignId: string;
  if (cfg.campaignMode === "existing" && cfg.campaignId) {
    campaignId = cfg.campaignId;
  } else {
    const c = await createCampaign({
      name: cfg.campaignName,
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetEur: abo ? undefined : cfg.dailyBudgetEur,
      adsetBudgetSharing: abo ? false : undefined,
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    });
    campaignId = c.id;
  }
  const as = await createAdSet({
    name: ((cfg.adSetName || "").trim() || `${cfg.campaignName} — ad set`).slice(0, 100),
    campaignId,
    optimizationGoal: cfg.optimizationGoal || "LEAD_GENERATION",
    billingEvent: "IMPRESSIONS",
    destinationType: "ON_AD",
    promotedObject: { page_id: pageId() },
    attributionSpec: attributionSpecFor(cfg.attributionDays),
    targeting: buildTargeting(cfg),
    status: "PAUSED",
    dailyBudgetEur: abo ? cfg.dailyBudgetEur : undefined,
    startTime: cfg.scheduleStart || (abo ? new Date().toISOString() : undefined),
    endTime: cfg.scheduleEnd || undefined,
  });
  return as.id;
}

/** Resolve a duplicate "destination" to a target ad-set id. null = use the source ad's own ad set. */
export async function resolveDestinationAdSet(dest: any): Promise<string | null> {
  if (!dest || dest.mode === "same") return null;
  if (dest.mode === "existing") return dest.adSetId ? String(dest.adSetId) : null;
  if (dest.mode === "new") return await createOneAdSet(dest as NewAdSetConfig);
  return null;
}

/**
 * Asset-feed (Advantage+) creatives are rejected by ad sets that still carry the deprecated
 * `targeting_optimization` field. Strip it (once per ad set) so Flexible/Multi-Ratio can launch.
 * Idempotent: a no-op when the field is absent. Never touches status.
 */
const WRITE_DEPRECATED_POSITIONS = new Set(["video_feeds", "facebook_reels_overlay", "profile_reels"]);
// Only the writable targeting fields (reading the whole object pulls in read-only/deprecated bits that get rejected on write).
const SAFE_TARGETING_FIELDS =
  "targeting{age_min,age_max,genders,geo_locations,publisher_platforms,facebook_positions,instagram_positions,device_platforms,targeting_automation,brand_safety_content_filter_levels,targeting_optimization}";

async function ensureAssetFeedReady(adSetId: string, done: Set<string>): Promise<void> {
  if (done.has(adSetId)) return;
  done.add(adSetId);
  try {
    const cur = await metaGet<any>(adSetId, { fields: SAFE_TARGETING_FIELDS });
    const t = cur?.targeting;
    if (!t || t.targeting_optimization == null) return; // nothing to fix — leave the ad set untouched

    const next: Record<string, any> = { ...t };
    delete next.targeting_optimization; // deprecated; Meta rejects it for asset-feed ads
    delete next.age_range; // read-only echo, rejected on write
    const keep = (xs: any) => (Array.isArray(xs) ? xs.filter((p: string) => !WRITE_DEPRECATED_POSITIONS.has(p)) : xs);
    if (next.facebook_positions) next.facebook_positions = keep(next.facebook_positions);
    if (next.instagram_positions) {
      let ig = keep(next.instagram_positions) as string[];
      if (ig.includes("explore_home") && !ig.includes("explore")) ig = [...ig, "explore"]; // Meta dependency
      next.instagram_positions = ig;
    }
    if (next.targeting_automation) next.targeting_automation = { advantage_audience: next.targeting_automation.advantage_audience ? 1 : 0 };
    await updateObject(adSetId, { targeting: next });
  } catch {
    // best-effort — if this fails, the createAd below surfaces the real error
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a freshly-uploaded video's thumbnail to be generated; returns its uri (or null on timeout). */
async function getVideoThumbnail(videoId: string, timeoutMs = 90000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await metaGet<any>(videoId, { fields: "thumbnails{uri,is_preferred}" });
      const thumbs = v?.thumbnails?.data;
      if (Array.isArray(thumbs) && thumbs.length) {
        const pref = thumbs.find((t: any) => t.is_preferred) ?? thumbs[0];
        if (pref?.uri) return pref.uri;
      }
    } catch {
      // keep polling
    }
    await sleep(3000);
  }
  return null;
}

/**
 * Resolve a saved lead-form template to its Meta form id, creating it on Meta the first time.
 * `afterSubmitUrl` is the audience's destination URL — baked into the form's completion screen ("Visit
 * website" button). Precedence: per-audience override → the form's own thank-you URL → the global default.
 * The template's cached Meta form is reused only when it represents that same URL; a per-audience override
 * mints a one-off form variant (not stored on the template) so one template can redirect differently per audience.
 */
async function resolveLeadFormMetaId(
  admin: SupabaseClient,
  tenantId: string,
  templateId: string,
  afterSubmitUrl: string,
  defaultWebsiteUrl: string,
  privacyUrl: string
): Promise<string | null> {
  const { data: tpl } = await admin.from("lead_form_templates").select("*").eq("id", templateId).eq("tenant_id", tenantId).maybeSingle();
  if (!tpl) return null;
  const ty = (tpl.thank_you && typeof tpl.thank_you === "object" ? tpl.thank_you : {}) as Record<string, string>;
  // The form's canonical after-submit URL (its own, else the global default — NEVER the privacy page).
  const canonical = (ty.websiteUrl || tpl.follow_up_url || "").trim() || defaultWebsiteUrl;
  const websiteUrl = (afterSubmitUrl || "").trim() || canonical;
  // Reuse the cached Meta form only when it stands for this same after-submit URL.
  if (tpl.meta_form_id && websiteUrl === canonical) return tpl.meta_form_id as string;
  const form = await createLeadForm({
    name: tpl.name || "Lead form",
    privacyPolicyUrl: tpl.privacy_url || privacyUrl,
    questions: Array.isArray(tpl.questions) ? tpl.questions : undefined,
    contextCard: normalizeGreeting(tpl.greeting),
    thankYou: {
      title: ty.headline || "",
      body: ty.message || "",
      websiteUrl,
      buttonText: ty.buttonText || "",
    },
  });
  // Cache on the template only for the canonical URL — never cache a per-audience variant.
  if (websiteUrl === canonical) await admin.from("lead_form_templates").update({ meta_form_id: form.id }).eq("id", templateId);
  return form.id;
}

/**
 * Create the ads for a launch on Meta. One PAUSED ad per (row × selected ad set).
 * Supports Single (image/video), Carousel, Flexible and Multi-Ratio; a single image with multiple
 * copy variations is built as an asset-feed ad (needs Launch New, where it gets its own dynamic ad set).
 * STATUS IS HARD-CODED TO "PAUSED" — this function never activates anything.
 */
export async function launchAds(admin: SupabaseClient, tenantId: string, ads: LaunchAdInput[], newAdSet?: NewAdSetConfig): Promise<LaunchResult> {
  const result: LaunchResult = { created: [], errors: [] };
  const formCache = new Map<string, string | null>();
  const assetFeedReady = new Set<string>();

  // Idempotency for reclaimed batches: if a prior processor died after creating an ad but before requeueing,
  // a later reclaim re-runs the same rows. In existing-ad-set mode, look up each ad set's current ad names once
  // and skip a name that already exists, so a reclaim can't create duplicate paused ads on Meta (C9).
  const namesByAdSet = new Map<string, Set<string>>();
  const existingAdNames = async (adSetId: string): Promise<Set<string>> => {
    let names = namesByAdSet.get(adSetId);
    if (!names) {
      try {
        const rows = await metaGetAll<{ name?: string }>(`${adSetId}/ads`, { fields: "name", limit: "200" });
        names = new Set(rows.map((r) => (r.name || "").trim()).filter(Boolean));
      } catch {
        names = new Set();
      }
      namesByAdSet.set(adSetId, names);
    }
    return names;
  };
  // Resolved once: the standard destination + the form's privacy link (tenant overrides honored). Never privacy as a destination.
  const urls = await getUrlSettings(admin, tenantId);

  // "Launch New": create a fresh campaign + ad set(s) and assign them before creating any ads.
  const launchingNew = !!newAdSet;
  let work = ads;
  if (newAdSet) {
    try {
      work = await prepareNewAdSets(ads, newAdSet);
    } catch (e: any) {
      for (const ad of ads) result.errors.push({ name: ad.name, adSetId: null, error: e?.message || "Could not create the new ad set" });
      return result;
    }
  }

  // Pace bulk launches so the burst stays under Meta's per-account API rate limit (code 17). Auto-sized to
  // the batch and kept within the background function's time budget (this runs after image uploads, which
  // also consume part of the 300s). Gentle for small launches, tighter for large ones — reliability first.
  const adPaceMs = Math.max(1500, Math.min(3000, Math.floor(120000 / Math.max(1, work.length))));
  let adIndex = 0;
  for (const ad of work) {
    if (adIndex++ > 0) await sleep(adPaceMs);
    try {
      if (ad.format !== "single" && ad.format !== "carousel" && ad.format !== "flexible" && ad.format !== "multi_ratio") {
        result.errors.push({ name: ad.name, adSetId: null, error: `${ad.format} launches aren't supported yet` });
        continue;
      }
      if (!ad.adSetIds.length) {
        result.errors.push({ name: ad.name, adSetId: null, error: "No ad set selected" });
        continue;
      }
      const media = ad.images
        .map((b64, i) => ({ b64, hash: ad.imageHashes?.[i] || null, kind: (ad.kinds?.[i] ?? "image") as "image" | "video", ratio: ad.ratios?.[i] ?? "", videoId: ad.videoIds?.[i] || null }))
        .filter((m) => (m.kind === "video" ? !!m.videoId || (m.b64 && m.b64.length) : !!m.hash || (m.b64 && m.b64.length)));
      if (!media.length) {
        result.errors.push({ name: ad.name, adSetId: null, error: "No media" });
        continue;
      }
      if (media.some((m) => m.kind === "video") && ad.format !== "single") {
        result.errors.push({ name: ad.name, adSetId: null, error: "Video is only supported for single ads right now" });
        continue;
      }
      if (ad.format === "carousel" && media.length < 2) {
        result.errors.push({ name: ad.name, adSetId: null, error: "A carousel needs at least 2 cards" });
        continue;
      }

      let leadFormMetaId: string | null = null;
      if (ad.leadFormId) {
        // "meta:<id>" = a Meta form kept from a duplicated ad — use it as-is (not a local template).
        if (ad.leadFormId.startsWith("meta:")) {
          leadFormMetaId = ad.leadFormId.slice(5) || null;
        } else {
          // Key the cache by template + after-submit URL so per-audience redirects each resolve their own form.
          const afterUrl = (ad.afterSubmitUrl || "").trim();
          const cacheKey = `${ad.leadFormId}|${afterUrl}`;
          if (!formCache.has(cacheKey)) {
            formCache.set(cacheKey, await resolveLeadFormMetaId(admin, tenantId, ad.leadFormId, afterUrl, urls.defaultWebsiteUrl, urls.privacyUrl));
          }
          leadFormMetaId = formCache.get(cacheKey) ?? null;
        }
      }

      // Never send anyone to the privacy page. A form ad's link is cosmetic (the instant form opens on
      // click), so it uses the default website URL. A website ad MUST carry a real landing URL (from Launch
      // Settings) — if it's missing we block the ad rather than silently falling back to anything.
      const rawLink = (ad.link || "").trim();
      let link: string;
      if (leadFormMetaId) {
        link = withUtm(urls.defaultWebsiteUrl, ad.utm);
      } else {
        if (!rawLink) {
          result.errors.push({ name: ad.name, adSetId: null, error: "No landing page URL — set a Landing page in Launch Settings before launching a website ad" });
          continue;
        }
        link = withUtm(rawLink, ad.utm);
      }
      // Explicit Advantage+ creative spec for EVERY creative so the Enhancements toggle is deterministic
      // both ways (Meta auto-applies defaults when none is sent — true for asset-feed and basic alike).
      const dof = assetFeedFeatures(ad);
      const headline = ad.headline[0]?.trim() || undefined;
      const description = ad.description[0]?.trim() || undefined;
      const message = ad.primaryText[0]?.trim() || " ";

      let creative: { id: string };
      if (ad.format === "single" && media[0].kind === "video") {
        // Use the pre-uploaded video (large-video path) when present; otherwise upload the small inline bytes.
        const videoId = media[0].videoId || (await uploadAdVideo(Buffer.from(media[0].b64, "base64"), `${ad.name}.mp4`)).id;
        const thumbUrl = await getVideoThumbnail(videoId);
        creative = await createVideoCreative({
          name: `${ad.name} — creative`,
          message,
          link,
          headline,
          cta: ad.cta || "LEARN_MORE",
          leadGenFormId: leadFormMetaId || undefined,
          videoId,
          imageUrl: thumbUrl || undefined,
          degreesOfFreedom: dof,
        });
      } else {
        // Use the pre-uploaded hash (bulk-launch path) when present; otherwise upload the inline base64.
        const hashes = await Promise.all(media.map((m) => (m.hash ? Promise.resolve(m.hash) : uploadAdImage(m.b64).then((r) => r.hash))));
        if (usesAssetFeed(ad, launchingNew)) {
          // Flexible, Multi-Ratio, or a single image with multiple copy variations — all asset-feed creatives.
          // True Multi-Ratio: map the square image → Feed and the tall image → Stories/Reels.
          const plan = ad.format === "multi_ratio" ? planMultiRatio(media.map((m) => m.ratio), hashes) : null;
          // Multi-Ratio ad sets use manual IG placements, which require naming the IG identity on the creative.
          const igActor = ad.format === "multi_ratio" ? (await instagramActorId().catch(() => null)) || undefined : undefined;
          creative = await createFlexibleCreative({
            name: `${ad.name} — creative`,
            bodies: ad.primaryText,
            titles: ad.headline,
            descriptions: ad.description,
            link,
            cta: ad.cta || "LEARN_MORE",
            leadGenFormId: leadFormMetaId || undefined,
            imageHashes: plan ? plan.hashes : hashes,
            imageLabels: plan?.labels,
            assetCustomizationRules: plan?.rules,
            instagramActorId: igActor,
            degreesOfFreedom: dof, // Multi-Ratio keeps placement adaptation on for 9:16 Stories/Reels (see assetFeedFeatures)
          });
        } else if (ad.format === "carousel") {
          creative = await createCarouselCreative({
            name: `${ad.name} — creative`,
            message,
            link,
            cta: ad.cta || "LEARN_MORE",
            leadGenFormId: leadFormMetaId || undefined,
            cards: hashes.map((h) => ({ imageHash: h, name: headline, description })),
            degreesOfFreedom: dof,
          });
        } else {
          const baseCreative = {
            name: `${ad.name} — creative`,
            message,
            link,
            headline,
            description,
            imageHash: hashes[0],
            leadGenFormId: leadFormMetaId || undefined,
            callToAction: ad.cta || "LEARN_MORE",
            degreesOfFreedom: dof,
          };
          try {
            creative = await createAdCreative({ ...baseCreative, imageCrops: ad.imageCrops });
          } catch (e) {
            if (!ad.imageCrops) throw e;
            // Meta rejected the explicit Feed crop — launch the ad anyway without it (never fail over framing).
            creative = await createAdCreative(baseCreative);
          }
        }
      }

      const isAssetFeed = usesAssetFeed(ad, launchingNew);
      let anyCreated = false;
      for (const adSetId of ad.adSetIds) {
        try {
          if (isAssetFeed) await ensureAssetFeedReady(adSetId, assetFeedReady);
          // Reclaim idempotency (existing-ad-set mode only): skip if this named ad already exists here (C9).
          if (!launchingNew) {
            const existing = await existingAdNames(adSetId);
            if (existing.has(ad.name.trim())) {
              anyCreated = true;
              continue;
            }
          }
          const created = await createAd({ name: ad.name, adsetId: adSetId, creativeId: creative.id, status: "PAUSED" });
          result.created.push({ adId: created.id, creativeId: creative.id, adSetId, name: ad.name });
          namesByAdSet.get(adSetId)?.add(ad.name.trim()); // don't recreate within this run either
          anyCreated = true;
        } catch (e: any) {
          result.errors.push({ name: ad.name, adSetId, error: e?.message || "Failed to create ad" });
        }
      }
      // If no ad used this creative, delete it so failed launches don't litter the account.
      if (!anyCreated) await deleteObject(creative.id).catch(() => {});
    } catch (e: any) {
      result.errors.push({ name: ad.name, adSetId: null, error: e?.message || "Failed" });
    }
  }

  // Clean up ad sets WE created in this run that ended up with zero ads (a per-ad failure left them empty),
  // so a partial launch doesn't litter the account with empty PAUSED ad sets (C27). Never touches an
  // existing/user-picked ad set (only launchingNew ad sets are candidates).
  if (launchingNew) {
    const usedAdSets = new Set(result.created.map((c) => c.adSetId));
    const createdAdSets = new Set(work.flatMap((a) => a.adSetIds));
    for (const asid of createdAdSets) {
      if (!usedAdSets.has(asid)) await deleteObject(asid).catch(() => {});
    }
  }

  return result;
}

/**
 * Resolve a batch of rows' images (uploaded to storage as `imagePaths`) into Meta hashes, then launch them.
 * Shared by the initial launch AND each background batch. Returns the launch result plus the storage paths it
 * consumed (so the caller can delete them). The image uploads are paced to stay under the API rate limit.
 */
export async function launchRowsFromPaths(
  admin: SupabaseClient,
  tenantId: string,
  rows: any[],
  newAdSet?: NewAdSetConfig
): Promise<{ result: LaunchResult; paths: string[] }> {
  const paths = Array.from(
    new Set(rows.flatMap((r) => (Array.isArray(r.imagePaths) ? r.imagePaths : [])).filter((p: any): p is string => typeof p === "string" && !!p))
  ) as string[];
  const pathHash = new Map<string, string>();
  for (let i = 0; i < paths.length; i++) {
    if (i > 0) await sleep(1500);
    try {
      const { data: blob } = await admin.storage.from("launch-media").download(paths[i]);
      if (blob) {
        const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
        const { hash } = await uploadAdImage(base64);
        pathHash.set(paths[i], hash);
      }
    } catch {
      // a missing hash → that ad reports "No media" and the rest still launch
    }
  }
  const built: LaunchAdInput[] = rows.map((r) => ({
    ...r,
    imageHashes: (Array.isArray(r.imagePaths) ? r.imagePaths : []).map((p: any) => (p ? pathHash.get(p) ?? null : null)),
  }));
  const result = await launchAds(admin, tenantId, built, newAdSet);
  return { result, paths };
}
