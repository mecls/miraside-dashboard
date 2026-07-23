/**
 * Deep links into the real Facebook Ads Manager **performance/charts (insights)** view for a
 * given object. Client-safe (no server imports). Account id may arrive as "act_123" or "123".
 */
const BASE = "https://adsmanager.facebook.com/adsmanager/manage";
// Stable Business Manager id for the (single) Miraside account — required to open the insights view.
const BUSINESS_ID = "329549975846251";

function acct(fbAccountId: string) {
  return String(fbAccountId || "").replace(/^act_/, "");
}
function base(fbAccountId: string) {
  return `act=${acct(fbAccountId)}&business_id=${BUSINESS_ID}`;
}
const TAIL = "&nav_source=no_referrer";

export function campaignUrl(fbAccountId: string, fbCampaignId: string) {
  return `${BASE}/campaigns/insights?${base(fbAccountId)}&selected_campaign_ids=${fbCampaignId}${TAIL}`;
}

export function adsetUrl(fbAccountId: string, fbCampaignId: string, fbAdsetId: string) {
  const camp = fbCampaignId ? `&selected_campaign_ids=${fbCampaignId}` : "";
  return `${BASE}/adsets/insights?${base(fbAccountId)}${camp}&selected_adset_ids=${fbAdsetId}${TAIL}`;
}

export function adUrl(fbAccountId: string, fbAdsetId: string | null, fbAdId: string) {
  const adset = fbAdsetId ? `&selected_adset_ids=${fbAdsetId}` : "";
  return `${BASE}/ads/insights?${base(fbAccountId)}${adset}&selected_ad_ids=${fbAdId}${TAIL}`;
}
