import type { AdFormat, ColumnKey } from "../types";

export const CTA_OPTIONS = [
  { id: "LEARN_MORE", name: "Learn more" },
  { id: "SHOP_NOW", name: "Shop now" },
  { id: "SIGN_UP", name: "Sign up" },
  { id: "SUBSCRIBE", name: "Subscribe" },
  { id: "DOWNLOAD", name: "Download" },
  { id: "GET_QUOTE", name: "Get quote" },
  { id: "GET_OFFER", name: "Get offer" },
  { id: "APPLY_NOW", name: "Apply now" },
  { id: "CONTACT_US", name: "Contact us" },
];

export const REQUIRED_COLUMNS: ColumnKey[] = ["format", "status", "name", "media"];

export const OPTIONAL_COLUMNS: ColumnKey[] = [
  "primaryText",
  "headline",
  "description",
  "link",
  "whatsapp",
  "cta",
  "facebookPage",
  "instagramPage",
  "enhancements",
  "utm",
  "leadForm",
];

// Order columns always render in (required first, then optional).
export const COLUMN_ORDER: ColumnKey[] = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

// Lean default — Description, WhatsApp, Instagram Page, Enhancements and UTM Tags are hidden by
// default (still available via the column picker). Lead Form is shown — this is a lead-gen launcher.
export const DEFAULT_VISIBLE: ColumnKey[] = [
  "format",
  "status",
  "name",
  "media",
  "primaryText",
  "headline",
  "cta",
  "leadForm",
  "facebookPage",
];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  format: "Format",
  status: "Status",
  name: "Ad Name",
  media: "Media",
  primaryText: "Primary Text",
  headline: "Headline",
  description: "Description",
  link: "Link",
  whatsapp: "WhatsApp",
  cta: "CTA",
  facebookPage: "Facebook Page",
  instagramPage: "Instagram Page",
  enhancements: "Enhancements",
  utm: "UTM Tags",
  leadForm: "Lead Form",
};

export const COLUMN_WIDTH: Record<ColumnKey, number> = {
  format: 116,
  status: 116,
  name: 200,
  media: 124,
  primaryText: 480,
  headline: 244,
  description: 244,
  link: 160,
  whatsapp: 200,
  cta: 168,
  facebookPage: 200,
  instagramPage: 200,
  enhancements: 124,
  utm: 168,
  leadForm: 200,
};

export const FORMAT_META: Record<AdFormat, { label: string; variations: boolean }> = {
  single: { label: "Single", variations: true },
  flexible: { label: "Flexible", variations: true },
  multi_ratio: { label: "Multi", variations: false },
  carousel: { label: "Carousel", variations: false },
};

export const allowsVariations = (f: AdFormat) => FORMAT_META[f].variations;
