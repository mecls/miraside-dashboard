/**
 * Meta Ads write layer — CREATE + MANAGE.
 *
 * Thin, typed wrappers over metaPost/metaDelete (lib/meta.ts). All money is EUR and
 * converted to minor units (cents) for Meta. Create helpers default to PAUSED so
 * nothing ever spends without an explicit activation.
 */
import { metaGet, metaGetAll, metaPost, metaDelete, adAccountId, pageId, graphFetch } from "./meta";

export type AdStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";

// ---------------- MANAGE ----------------

/** Set status on a campaign / ad set / ad (the object id is the same shape for all three). */
export function setStatus(objectId: string, status: AdStatus) {
  return metaPost<{ success?: boolean; id?: string }>(objectId, { status });
}
export const pauseObject = (id: string) => setStatus(id, "PAUSED");
export const resumeObject = (id: string) => setStatus(id, "ACTIVE");
export const archiveObject = (id: string) => setStatus(id, "ARCHIVED");

/** Update a daily and/or lifetime budget on a campaign (CBO) or ad set (ABO). EUR -> cents. */
export function setBudget(objectId: string, opts: { dailyEur?: number; lifetimeEur?: number }) {
  const params: Record<string, any> = {};
  if (opts.dailyEur != null) params.daily_budget = Math.round(opts.dailyEur * 100);
  if (opts.lifetimeEur != null) params.lifetime_budget = Math.round(opts.lifetimeEur * 100);
  return metaPost(objectId, params);
}

/** Generic field update (rename, retarget, etc.) on any ads object. */
export function updateObject(objectId: string, fields: Record<string, any>) {
  return metaPost(objectId, fields);
}

/** Hard delete. Prefer archiveObject() for anything that has run. */
export function deleteObject(objectId: string) {
  return metaDelete(objectId);
}

/**
 * Native Meta copy: campaign (with ad sets + ads) / ad set (with ads) / ad — into the same parent.
 * Forced PAUSED two ways (status_option + an explicit pause of the copy) so a duplicate can NEVER spend.
 */
export async function copyObject(
  objectId: string,
  level: "campaign" | "adset" | "ad"
): Promise<{ id: string | null }> {
  const params: Record<string, any> = { status_option: "PAUSED" };
  if (level !== "ad") params.deep_copy = true; // bring children along (ad sets / ads)
  const res = await metaPost<any>(`${objectId}/copies`, params);
  const id = res?.copied_campaign_id ?? res?.copied_adset_id ?? res?.copied_ad_id ?? res?.id ?? null;
  if (id) {
    // Belt-and-suspenders: force the copy paused regardless of what status_option did.
    try { await setStatus(id, "PAUSED"); } catch {}
  }
  return { id };
}

// ---------------- CREATE: campaign ----------------

export type Objective =
  | "OUTCOME_LEADS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_SALES"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_APP_PROMOTION";

export function createCampaign(opts: {
  name: string;
  objective?: Objective;
  status?: "PAUSED" | "ACTIVE";
  /** Campaign-level daily budget (CBO), EUR. Omit to budget at the ad-set level (ABO). */
  dailyBudgetEur?: number;
  /** ABO only: let ad sets share 20% of budget. Meta requires this set explicitly when there's no campaign budget. */
  adsetBudgetSharing?: boolean;
  bidStrategy?: string;
}): Promise<{ id: string }> {
  const params: Record<string, any> = {
    name: opts.name,
    objective: opts.objective ?? "OUTCOME_LEADS",
    status: opts.status ?? "PAUSED",
    special_ad_categories: [], // REQUIRED by Meta, even when empty
  };
  if (opts.dailyBudgetEur != null) {
    params.daily_budget = Math.round(opts.dailyBudgetEur * 100); // CBO
    params.bid_strategy = opts.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP"; // CBO requires an explicit bid strategy
  } else {
    params.is_adset_budget_sharing_enabled = opts.adsetBudgetSharing ?? false; // ABO — Meta requires this explicitly
  }
  return metaPost(`${adAccountId()}/campaigns`, params);
}

/**
 * The ad account's Meta Pixel id (first one found), cached for the process. Needed as the
 * promoted_object for landing-page conversion ad sets (optimize for the "Lead" website event).
 * Returns null when the account has no pixel yet.
 */
let _pixelId: string | null | undefined;
export async function getAccountPixelId(): Promise<string | null> {
  if (_pixelId !== undefined) return _pixelId;
  try {
    const r = await metaGet<{ data?: Array<{ id: string }> }>(`${adAccountId()}/adspixels`, { fields: "id,name", limit: "5" });
    _pixelId = r?.data?.[0]?.id ?? null; // cache only a CONFIRMED result (null = account genuinely has no pixel)
    return _pixelId;
  } catch {
    // Transient failure — don't poison the cache for the whole warm lambda or every later landing-page
    // launch fails "No Meta Pixel found" until a cold start (C26).
    return null;
  }
}

// ---------------- CREATE: ad set ----------------

export function createAdSet(opts: {
  name: string;
  campaignId: string;
  /** LINK_CLICKS / LANDING_PAGE_VIEWS / OFFSITE_CONVERSIONS / LEAD_GENERATION / REACH … */
  optimizationGoal?: string;
  billingEvent?: string; // usually IMPRESSIONS
  bidStrategy?: string; // LOWEST_COST_WITHOUT_CAP by default
  /** Ad-set daily budget (ABO), EUR. Omit when the campaign carries the budget (CBO). */
  dailyBudgetEur?: number;
  /** Full targeting object; or use the convenience fields below. */
  targeting?: Record<string, any>;
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  genders?: number[]; // [1]=men, [2]=women; omit for all
  startTime?: string; // ISO; required by Meta when ABO + no campaign schedule
  endTime?: string;
  status?: "PAUSED" | "ACTIVE";
  /** Required for conversion/lead optimization (e.g. { pixel_id, custom_event_type } or { page_id }). */
  promotedObject?: Record<string, any>;
  /** e.g. "ON_AD" for native instant lead forms. */
  destinationType?: string;
  attributionSpec?: Array<Record<string, any>>;
  /** Required for Flexible / Multi-Ratio (asset-feed) ads — those need a dedicated dynamic-creative ad set. */
  isDynamicCreative?: boolean;
}): Promise<{ id: string }> {
  const targeting =
    opts.targeting ?? {
      geo_locations: { countries: opts.countries ?? ["PT"] },
      age_min: opts.ageMin ?? 18,
      age_max: opts.ageMax ?? 65,
      ...(opts.genders ? { genders: opts.genders } : {}),
    };
  const params: Record<string, any> = {
    name: opts.name,
    campaign_id: opts.campaignId,
    status: opts.status ?? "PAUSED",
    optimization_goal: opts.optimizationGoal ?? "LINK_CLICKS",
    billing_event: opts.billingEvent ?? "IMPRESSIONS",
    targeting,
  };
  // Bid strategy lives on the ad set only for ABO; under CBO it's inherited from the campaign.
  if (opts.bidStrategy) params.bid_strategy = opts.bidStrategy;
  else if (opts.dailyBudgetEur != null) params.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
  if (opts.dailyBudgetEur != null) params.daily_budget = Math.round(opts.dailyBudgetEur * 100);
  if (opts.destinationType) params.destination_type = opts.destinationType;
  if (opts.attributionSpec) params.attribution_spec = opts.attributionSpec;
  if (opts.isDynamicCreative) params.is_dynamic_creative = true;
  if (opts.startTime) params.start_time = opts.startTime;
  if (opts.endTime) params.end_time = opts.endTime;
  if (opts.promotedObject) params.promoted_object = opts.promotedObject;
  return metaPost(`${adAccountId()}/adsets`, params);
}

// ---------------- CREATE: image + creative + ad ----------------

/** Upload an image (base64 of the file bytes) → returns the image_hash for a creative. */
export async function uploadAdImage(base64Bytes: string): Promise<{ hash: string }> {
  const res = await metaPost<{ images: Record<string, { hash: string }> }>(`${adAccountId()}/adimages`, {
    bytes: base64Bytes,
  });
  const first = Object.values(res.images || {})[0];
  if (!first?.hash) throw new Error("Image upload returned no hash");
  return { hash: first.hash };
}

/**
 * Dynamic URL parameters Meta appends to every website-destination ad's link, with the macros resolved
 * per click — so landing-page leads carry which ad they came from (see SOURCE-TRACKING.md). Lead-form
 * ads skip this (they get ad_id from Meta's lead metadata, not the URL).
 */
const AD_TRACKING_URL_TAGS = "ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}";

export function createAdCreative(opts: {
  name: string;
  message: string; // primary text
  link: string; // destination URL
  headline?: string; // shown as link title
  description?: string;
  imageHash?: string; // from uploadAdImage
  picture?: string; // alternative: a hosted image URL
  callToAction?: string; // LEARN_MORE / SIGN_UP / SUBSCRIBE / CONTACT_US …
  /** When set, the ad opens this native on-ad instant lead form. */
  leadGenFormId?: string;
  /** Per-ratio pixel crops (e.g. {"400x500":[[x1,y1],[x2,y2]]}) — explicit Feed framing from the crop tool. */
  imageCrops?: Record<string, number[][]>;
  /** Optional degrees_of_freedom_spec (creative enhancements + auto-crop). See creativeFeatures(). */
  degreesOfFreedom?: Record<string, any>;
}): Promise<{ id: string }> {
  const link_data: Record<string, any> = { message: opts.message, link: opts.link };
  if (opts.headline) link_data.name = opts.headline;
  if (opts.description) link_data.description = opts.description;
  if (opts.imageHash) link_data.image_hash = opts.imageHash;
  if (opts.imageCrops && Object.keys(opts.imageCrops).length) link_data.image_crops = opts.imageCrops;
  if (opts.picture) link_data.picture = opts.picture;
  link_data.call_to_action = opts.leadGenFormId
    ? { type: opts.callToAction ?? "SIGN_UP", value: { lead_gen_form_id: opts.leadGenFormId, link: opts.link } }
    : { type: opts.callToAction ?? "LEARN_MORE", value: { link: opts.link } };

  const body: Record<string, any> = { name: opts.name, object_story_spec: { page_id: pageId(), link_data } };
  if (opts.degreesOfFreedom) body.degrees_of_freedom_spec = opts.degreesOfFreedom;
  if (!opts.leadGenFormId) body.url_tags = AD_TRACKING_URL_TAGS; // website ad → carry ad_id/adset_id/campaign_id
  return metaPost(`${adAccountId()}/adcreatives`, body);
}

/** A single-video creative (object_story_spec.video_data), with an optional thumbnail + on-ad lead form. */
export function createVideoCreative(opts: {
  name: string;
  message: string;
  link: string;
  headline?: string;
  cta?: string;
  leadGenFormId?: string;
  videoId: string;
  imageUrl?: string; // thumbnail (Meta auto-generates one if omitted, once processing finishes)
  degreesOfFreedom?: Record<string, any>;
}): Promise<{ id: string }> {
  const ctaType = opts.cta ?? (opts.leadGenFormId ? "SIGN_UP" : "LEARN_MORE");
  const ctaValue = opts.leadGenFormId ? { lead_gen_form_id: opts.leadGenFormId, link: opts.link } : { link: opts.link };
  const video_data: Record<string, any> = {
    video_id: opts.videoId,
    message: opts.message,
    call_to_action: { type: ctaType, value: ctaValue },
  };
  if (opts.headline) video_data.title = opts.headline;
  if (opts.imageUrl) video_data.image_url = opts.imageUrl;
  const body: Record<string, any> = { name: opts.name, object_story_spec: { page_id: pageId(), video_data } };
  if (opts.degreesOfFreedom) body.degrees_of_freedom_spec = opts.degreesOfFreedom;
  if (!opts.leadGenFormId) body.url_tags = AD_TRACKING_URL_TAGS; // website ad → carry ad_id/adset_id/campaign_id
  return metaPost(`${adAccountId()}/adcreatives`, body);
}

/** A flexible creative: multiple images + copy variations in one ad; Meta optimizes the combination. */
export function createFlexibleCreative(opts: {
  name: string;
  bodies: string[]; // primary text variation(s)
  titles: string[]; // headline variation(s)
  descriptions: string[];
  link: string;
  cta?: string;
  leadGenFormId?: string;
  imageHashes: string[];
  imageLabels?: string[]; // parallel adlabel names (true Multi-Ratio: maps images to placements)
  assetCustomizationRules?: any[]; // asset_customization_rules referencing the image labels
  instagramActorId?: string; // required when the creative explicitly targets Instagram placements
  degreesOfFreedom?: Record<string, any>;
}): Promise<{ id: string }> {
  const ctaType = opts.cta ?? (opts.leadGenFormId ? "SIGN_UP" : "LEARN_MORE");
  // Meta requires every asset value (image, body, title, description) to be unique.
  const clean = (xs: string[]) => Array.from(new Set(xs.map((t) => t.trim()).filter(Boolean)));
  const bodies = clean(opts.bodies);
  const titles = clean(opts.titles);
  const descriptions = clean(opts.descriptions);
  // With placement customization each image carries a label the rules reference (kept distinct, no dedupe);
  // otherwise just dedupe the hashes.
  const images = opts.imageLabels
    ? opts.imageHashes.map((h, i) => ({ hash: h, adlabels: [{ name: opts.imageLabels![i] }] }))
    : Array.from(new Set(opts.imageHashes)).map((h) => ({ hash: h }));
  const asset_feed_spec: Record<string, any> = {
    images,
    bodies: (bodies.length ? bodies : [" "]).map((text) => ({ text })),
    ad_formats: ["SINGLE_IMAGE"],
    link_urls: [{ website_url: opts.link }],
  };
  if (titles.length) asset_feed_spec.titles = titles.map((text) => ({ text }));
  if (descriptions.length) asset_feed_spec.descriptions = descriptions.map((text) => ({ text }));
  if (opts.assetCustomizationRules?.length) asset_feed_spec.asset_customization_rules = opts.assetCustomizationRules;
  if (opts.leadGenFormId) {
    asset_feed_spec.call_to_actions = [{ type: ctaType, value: { lead_gen_form_id: opts.leadGenFormId, link: opts.link } }];
  } else {
    asset_feed_spec.call_to_action_types = [ctaType];
  }
  const oss: Record<string, any> = { page_id: pageId() };
  if (opts.instagramActorId) oss.instagram_user_id = opts.instagramActorId; // current field (instagram_actor_id is deprecated)
  const body: Record<string, any> = { name: opts.name, object_story_spec: oss, asset_feed_spec };
  if (opts.degreesOfFreedom) body.degrees_of_freedom_spec = opts.degreesOfFreedom;
  if (!opts.leadGenFormId) body.url_tags = AD_TRACKING_URL_TAGS; // website ad → carry ad_id/adset_id/campaign_id
  return metaPost(`${adAccountId()}/adcreatives`, body);
}

/** A carousel creative: 2+ swipeable cards (each its own image), sharing the ad's primary text + CTA. */
export function createCarouselCreative(opts: {
  name: string;
  message: string; // primary text (ad level)
  link: string; // destination URL (cards share it)
  cta?: string;
  leadGenFormId?: string; // native on-ad instant form (same for every card)
  cards: { imageHash: string; name?: string; description?: string }[];
  degreesOfFreedom?: Record<string, any>;
}): Promise<{ id: string }> {
  const ctaType = opts.cta ?? (opts.leadGenFormId ? "SIGN_UP" : "LEARN_MORE");
  const ctaValue = opts.leadGenFormId ? { lead_gen_form_id: opts.leadGenFormId, link: opts.link } : { link: opts.link };
  const child_attachments = opts.cards.map((c) => ({
    image_hash: c.imageHash,
    link: opts.link,
    ...(c.name ? { name: c.name } : {}),
    ...(c.description ? { description: c.description } : {}),
    call_to_action: { type: ctaType, value: ctaValue },
  }));
  const link_data: Record<string, any> = {
    message: opts.message,
    link: opts.link,
    child_attachments,
    multi_share_optimized: true, // let Meta order the cards by performance
    multi_share_end_card: false,
    call_to_action: { type: ctaType, value: ctaValue },
  };
  const body: Record<string, any> = { name: opts.name, object_story_spec: { page_id: pageId(), link_data } };
  if (opts.degreesOfFreedom) body.degrees_of_freedom_spec = opts.degreesOfFreedom;
  if (!opts.leadGenFormId) body.url_tags = AD_TRACKING_URL_TAGS; // website ad → carry ad_id/adset_id/campaign_id
  return metaPost(`${adAccountId()}/adcreatives`, body);
}

/**
 * Creative enhancements + per-placement auto-crop, as individual opt-ins.
 * (The umbrella "standard_enhancements" bundle was deprecated in Marketing API v22.0 and is
 * rejected on create — we opt into the individual features instead.) Verified against v25 docs.
 */
export function creativeFeatures(autoCrop: boolean): Record<string, any> {
  return {
    creative_features_spec: {
      image_touchups: { enroll_status: "OPT_IN" },
      text_optimizations: { enroll_status: "OPT_IN" },
      inline_comment: { enroll_status: "OPT_IN" },
      adapt_to_placement: { enroll_status: autoCrop ? "OPT_IN" : "OPT_OUT" }, // per-placement auto-crop toggle
    },
  };
}

/** Read an existing ad's current editable creative bits (handles link_data + asset_feed_spec). */
export async function getAdCreativeInfo(adFbId: string): Promise<{
  creativeId: string | null;
  imageHash: string | null;
  leadGenFormId: string | null;
  link: string | null;
  message: string;
  headline: string;
  description: string;
  cta: string;
  autoCrop: boolean;
}> {
  const ad = await metaGet<any>(adFbId, {
    fields: "creative{id,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,image_hash}",
  });
  const c = ad.creative ?? {};
  const link = c.object_story_spec?.link_data ?? {};
  const afs = c.asset_feed_spec ?? {};
  const imageHash = link.image_hash ?? afs.images?.[0]?.hash ?? c.image_hash ?? null;
  let leadGenFormId: string | null = link.call_to_action?.value?.lead_gen_form_id ?? null;
  if (!leadGenFormId && Array.isArray(afs.call_to_actions)) {
    for (const a of afs.call_to_actions) {
      const v = a?.value?.lead_gen_form_id;
      if (v) { leadGenFormId = v; break; }
    }
  }
  const adapt = c.degrees_of_freedom_spec?.creative_features_spec?.adapt_to_placement?.enroll_status;
  // Preserve the ad's real destination link (incl. landing-page fb_ad_id params) instead of
  // overwriting it on rebuild. fb.me is Meta's placeholder for native lead forms.
  const destLink = link.link ?? afs.link_urls?.[0]?.website_url ?? null;
  return {
    creativeId: c.id ?? null,
    imageHash,
    leadGenFormId,
    link: destLink && destLink !== "http://fb.me/" ? destLink : null,
    message: link.message ?? afs.bodies?.[0]?.text ?? "",
    headline: link.name ?? afs.titles?.[0]?.text ?? "",
    description: link.description ?? afs.descriptions?.[0]?.text ?? "",
    cta: link.call_to_action?.type ?? afs.call_to_actions?.[0]?.type ?? "LEARN_MORE",
    autoCrop: adapt ? adapt === "OPT_IN" : true,
  };
}

// ---------------- LEAD FORMS (native instant forms) ----------------

/**
 * Mint a Page access token from the system-user token (required for lead-form operations).
 *
 * Meta occasionally answers 200 with the `access_token` field simply absent. That isn't an API *error*, so
 * metaGet's retry never engaged and one blip killed a whole scheduled Leads sync ("Could not obtain a Page
 * access token."). Retry the empty answer, and cache the token per process — we were re-minting it on every
 * single lead-form call.
 */
let pageTokenCache: { token: string; at: number } | null = null;
const PAGE_TOKEN_TTL_MS = 10 * 60_000;

export async function pageAccessToken(): Promise<string> {
  if (pageTokenCache && Date.now() - pageTokenCache.at < PAGE_TOKEN_TTL_MS) return pageTokenCache.token;
  let last = "";
  for (let i = 0; i < 3; i++) {
    const r = await metaGet<{ access_token?: string }>(pageId(), { fields: "access_token" });
    if (r.access_token) {
      pageTokenCache = { token: r.access_token, at: Date.now() };
      return r.access_token;
    }
    last = "Meta returned no access_token for the Page";
    if (i < 2) await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
  throw new Error(`Could not obtain a Page access token. (${last})`);
}

const LEAD_API = () => `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}`;

/**
 * Create a native instant lead form on the Page → returns its id (used in the creative).
 * Optional `contextCard` (greeting/intro) and `thankYou` (after-submit screen) match Meta's
 * context_card / thank_you_page objects. Forms default to the standard ("more volume") experience.
 */
export async function createLeadForm(opts: {
  name: string;
  privacyPolicyUrl: string;
  followUpUrl?: string; // legacy fallback when no thank-you screen is configured
  locale?: string;
  questions?: Array<Record<string, any>>;
  privacyLinkText?: string;
  contextCard?: { title: string; style: string; content: string[]; button_text?: string } | null;
  thankYou?: { title?: string; body?: string; websiteUrl?: string; buttonText?: string } | null;
}): Promise<{ id: string }> {
  const pageToken = await pageAccessToken();
  const body = new URLSearchParams({
    name: opts.name,
    // Meta renders the PRE-DEFINED questions (Full name / Email / Phone) in this locale — we never send a
    // label for those, so the locale is the only thing that makes them read "Nome completo" to a PT lead.
    // Write the value as PT_PT (all caps); Meta reads it back as pt_PT. Never round-trip a read into a write.
    locale: opts.locale ?? "PT_PT",
    questions: JSON.stringify(opts.questions ?? [{ type: "FULL_NAME" }, { type: "EMAIL" }, { type: "PHONE" }]),
    privacy_policy: JSON.stringify({ url: opts.privacyPolicyUrl, link_text: opts.privacyLinkText || "Política de Privacidade" }),
    access_token: pageToken,
  });
  if (opts.contextCard) body.set("context_card", JSON.stringify(opts.contextCard));
  if (opts.thankYou) {
    const t = opts.thankYou;
    const website = (t.websiteUrl || "").trim();
    // Meta stores these advertiser-supplied strings verbatim — locale does NOT translate them.
    const tp: Record<string, any> = {
      title: t.title?.trim() || "Obrigado!",
      body: t.body?.trim() || "Entraremos em contacto brevemente.",
      button_type: website ? "VIEW_WEBSITE" : "NONE",
    };
    if (website) {
      tp.website_url = website;
      tp.button_text = t.buttonText?.trim() || "Visitar o site";
    }
    body.set("thank_you_page", JSON.stringify(tp));
  } else if (opts.followUpUrl) {
    body.set("follow_up_action_url", opts.followUpUrl);
  }
  // Meta requires lead-form names to be UNIQUE per Page, and forms are immutable — so editing a saved form
  // (which clears its cached meta_form_id) re-mints under the same name and Meta rejects it with
  // "Form Name already exists" (code 100 / subcode 1892019). That made every edit-then-relaunch fail.
  // Retry with a numeric suffix so the fresh form still carries the user's name, recognisably.
  const base = opts.name;
  for (let n = 1; ; n++) {
    body.set("name", n === 1 ? base : `${base} (${n})`);
    try {
      // Through graphFetch for code-17 backoff; rateOnly so a transient error can't mint a duplicate form (C25).
      return await graphFetch(`${LEAD_API()}/${pageId()}/leadgen_forms`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, { rateOnly: true });
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      const nameTaken = /form name already exists/i.test(msg) || /subcode 1892019/.test(msg);
      if (!nameTaken || n >= 25) throw e;
    }
  }
}

/** Archive a lead form (forms can't be hard-deleted, only archived). */
export async function archiveLeadForm(formId: string): Promise<void> {
  const pageToken = await pageAccessToken();
  // graphFetch throws on a Meta error, so a failed archive no longer returns silently as success (C24).
  await graphFetch(`${LEAD_API()}/${formId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ status: "ARCHIVED", access_token: pageToken }).toString(),
  }, { rateOnly: true });
}

// ---------------- LEAD RETRIEVAL (reading submitted leads) ----------------

export interface MetaLeadForm {
  id: string;
  name: string;
  status: string;
}

export interface MetaLeadRaw {
  id: string;
  created_time: string;
  ad_id?: string | null;
  ad_name?: string | null;
  adset_id?: string | null;
  adset_name?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  form_id?: string | null;
  field_data: Array<{ name: string; values: string[] }>;
}

/** Follow a Graph edge fully (paging.next already carries the token). Throws on Meta errors. */
async function fetchAllPaged<T = any>(firstUrl: string): Promise<T[]> {
  let next: string | null = firstUrl;
  const out: T[] = [];
  while (next) {
    const json: any = await graphFetch(next); // retry/backoff so one transient blip doesn't fail the whole sync (C25/C32)
    if (Array.isArray(json.data)) out.push(...json.data);
    next = json.paging?.next ?? null;
  }
  return out;
}

/**
 * List the Page's instant lead forms. Reading leads needs the Page token (not the system-user token),
 * so this — and getLeadsForForm — use pageAccessToken() rather than metaGet. Includes archived forms by
 * default because archived forms still retain their historical leads.
 */
export async function listPageLeadForms(opts: { activeOnly?: boolean } = {}): Promise<MetaLeadForm[]> {
  const pageToken = await pageAccessToken();
  const url = `${LEAD_API()}/${pageId()}/leadgen_forms?fields=id,name,status&limit=100&access_token=${encodeURIComponent(pageToken)}`;
  const forms = await fetchAllPaged<MetaLeadForm>(url);
  return opts.activeOnly ? forms.filter((f) => f.status === "ACTIVE") : forms;
}

/**
 * Read ONE of the Page's instant forms in full — questions (+ their options), intro card and thank-you
 * screen. Backs the read-only view of an "on Meta" form: those can't be edited (Meta silently ignores
 * writes), but you should still be able to see exactly how one is built.
 */
export async function getLeadFormDefinition(formId: string): Promise<any> {
  const pageToken = await pageAccessToken();
  const u = new URL(`${LEAD_API()}/${formId}`);
  u.searchParams.set("fields", "id,name,status,locale,questions,context_card,thank_you_page");
  u.searchParams.set("access_token", pageToken);
  return graphFetch(u.toString());
}

/** Fetch a single submitted lead by its leadgen id (used by the realtime leadgen webhook). */
export async function getLead(leadgenId: string): Promise<MetaLeadRaw | null> {
  const pageToken = await pageAccessToken();
  const u = new URL(`${LEAD_API()}/${leadgenId}`);
  u.searchParams.set(
    "fields",
    "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data"
  );
  u.searchParams.set("access_token", pageToken);
  const j: any = await graphFetch(u.toString()); // retry/backoff (C25/C32)
  return j?.id ? (j as MetaLeadRaw) : null;
}

/**
 * Read every lead submitted to one form, newest-first, with full ad attribution + answers.
 * `sinceUnix` (optional) limits to leads created after that epoch-seconds time, for incremental sync.
 */
export async function getLeadsForForm(formId: string, sinceUnix?: number): Promise<MetaLeadRaw[]> {
  const pageToken = await pageAccessToken();
  const u = new URL(`${LEAD_API()}/${formId}/leads`);
  u.searchParams.set(
    "fields",
    "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data"
  );
  u.searchParams.set("limit", "200");
  if (sinceUnix && sinceUnix > 0) {
    u.searchParams.set(
      "filtering",
      JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(sinceUnix) }])
    );
  }
  u.searchParams.set("access_token", pageToken);
  return fetchAllPaged<MetaLeadRaw>(u.toString());
}

export function createAd(opts: {
  name: string;
  adsetId: string;
  creativeId: string;
  status?: "PAUSED" | "ACTIVE";
}): Promise<{ id: string }> {
  return metaPost(`${adAccountId()}/ads`, {
    name: opts.name,
    adset_id: opts.adsetId,
    creative: { creative_id: opts.creativeId },
    status: opts.status ?? "PAUSED",
  });
}

// ---------------- PREVIEW ----------------

/** Preview surfaces (all verified to render for our single-image lead creative). */
export const PREVIEW_FORMATS = [
  "MOBILE_FEED_STANDARD", "DESKTOP_FEED_STANDARD", "FACEBOOK_STORY_MOBILE", "FACEBOOK_REELS_MOBILE",
  "MARKETPLACE_MOBILE", "RIGHT_COLUMN_STANDARD",
  "INSTAGRAM_STANDARD", "INSTAGRAM_STORY", "INSTAGRAM_REELS", "INSTAGRAM_EXPLORE_CONTEXTUAL",
] as const;

/**
 * Render real Facebook/Instagram previews from a creative SPEC (object_story_spec),
 * WITHOUT creating any creative or ad. Runs all formats in parallel; preserves order;
 * silently drops any surface Meta can't render for this creative.
 */
export async function generateAdPreview(
  creativeSpec: Record<string, any>,
  formats: readonly string[] = PREVIEW_FORMATS
): Promise<Array<{ format: string; body: string }>> {
  const results = await Promise.all(
    formats.map(async (ad_format) => {
      try {
        const p = await metaGet<{ data?: Array<{ body?: string }> }>(`${adAccountId()}/generatepreviews`, {
          ad_format,
          creative: JSON.stringify(creativeSpec),
        });
        const body = p?.data?.[0]?.body;
        return body ? { format: ad_format, body } : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is { format: string; body: string } => r !== null);
}

// ---------------- READ: hierarchy (for the Create picker) ----------------

export type AdSetLite = { id: string; name: string; status: string; optimizationGoal?: string };
export type CampaignLite = {
  id: string;
  name: string;
  status: string;
  objective?: string;
  dailyBudgetEur?: number | null;
  adsets: AdSetLite[];
};

/** Live campaign → ad set tree for the "add to existing ad set" picker (current, not sync-lagged). */
export async function listCampaignsWithAdSets(): Promise<CampaignLite[]> {
  const acct = adAccountId();
  const [camps, adsets] = await Promise.all([
    metaGetAll<any>(`${acct}/campaigns`, { fields: "id,name,status,objective,daily_budget", limit: "200" }),
    metaGetAll<any>(`${acct}/adsets`, { fields: "id,name,status,optimization_goal,campaign_id", limit: "500" }),
  ]);
  const byCampaign = new Map<string, AdSetLite[]>();
  for (const s of adsets) {
    const arr = byCampaign.get(s.campaign_id) ?? [];
    arr.push({ id: s.id, name: s.name, status: s.status, optimizationGoal: s.optimization_goal });
    byCampaign.set(s.campaign_id, arr);
  }
  return camps.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective,
    dailyBudgetEur: c.daily_budget ? Number(c.daily_budget) / 100 : null,
    adsets: byCampaign.get(c.id) ?? [],
  }));
}
