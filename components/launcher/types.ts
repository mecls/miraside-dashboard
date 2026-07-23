// Shared types for the (new) creative-first Ad Launcher.

export type CreativeKind = "image" | "video";

/** A file the user dropped/picked, held in the browser before any upload. */
export type UploadedCreative = {
  id: string;
  file: File;
  name: string;
  kind: CreativeKind;
  previewUrl: string; // object URL for in-browser preview
  size: number;
  // Set only for folder imports: the leaf folder this creative came from. `bucket` is a stable id
  // (the leaf dir path), `bucketName` its short display label ("Ângulo N · Design"). Drives the
  // "one ad set per folder" launch mode; null for flat (non-folder) imports.
  bucket?: string | null;
  bucketName?: string | null;
};

/** The four ad formats offered on the "Choose Ad Format" step. */
export type AdFormat = "single" | "multi_ratio" | "flexible" | "carousel";

/** The formats that get an extra grouping step before Ad Setup. */
export type GroupableFormat = "multi_ratio" | "flexible" | "carousel";

/** A user-formed group of creatives (a multi-ratio ad, a flexible ad, or a carousel). */
export type Group = { id: string; creativeIds: string[] };

// ---- Ad Setup table ----

export type AdStatus = "ACTIVE" | "PAUSED";

export type ColumnKey =
  | "format"
  | "status"
  | "name"
  | "media"
  | "primaryText"
  | "headline"
  | "description"
  | "link"
  | "whatsapp"
  | "cta"
  | "facebookPage"
  | "instagramPage"
  | "enhancements"
  | "utm"
  | "leadForm";

/** One ad in the Ad Setup table (held in the browser before launch). */
export type AdRow = {
  id: string;
  format: AdFormat;
  status: AdStatus;
  name: string;
  creativeIds: string[];
  primaryText: string[]; // copy variations (1..5); length 1 for non-variation formats
  headline: string[];
  description: string[];
  link: string;
  whatsapp: string | null;
  cta: string;
  facebookPageId: string | null;
  instagramId: string | null;
  enhancements: boolean;
  utm: string;
  leadFormId: string | null;
  // Per-ad Feed framing: the 4:5 crop the user drew over the 9:16 (normalized 0–1 of the image). Stories/
  // Reels keep the full image; Feed uses this crop. Null/undefined = let Meta auto-fit.
  feedCrop?: { x: number; y: number; w: number; h: number } | null;
  adSetIds: string[];
  // "Launch New" multi-audience: which audience/ad-set(s) this ad launches into.
  // Empty = all audiences (the common case). Ignored in "Existing" mode (adSetIds rules there).
  audienceIds: string[];
  // Folder-import provenance (carried from the creative): which leaf folder this ad came from.
  // In "one ad set per folder" mode this bucket becomes the ad set the ad launches into.
  bucket?: string | null;
  bucketName?: string | null;
};

export type Option = { id: string; name: string };
export type AdSetOption = { id: string; name: string; active?: boolean };
export type AdSetGroup = { campaignId: string; campaignName: string; adSets: AdSetOption[] };

/** An existing live ad in the account (for the "Duplicate existing ads" flow). */
export type ExistingAd = { id: string; fbAdId: string; name: string; status: string; thumb: string | null };

/** Editable targeting + ad-set settings for a "Launch New" campaign. Defaults = the proven setup. */
export type LaunchAudience = {
  countries: string[];
  ageMin: number;
  ageMax: number;
  genders: number[] | null; // null = all; [1] = men; [2] = women
  advantageAudience: boolean;
  facebook: boolean;
  instagram: boolean;
  placements: string[]; // PlacementKey[]; empty = automatic (all placements)
  optimizationGoal: string; // LEAD_GENERATION | QUALITY_LEAD (only used for the instant-form destination)
  attributionDays: number; // 1 | 7 (click-through window)
  scheduleStart: string; // "" or a datetime-local value
  scheduleEnd: string;
  // Where the ad sends people: a native instant form, or a landing page (website conversions).
  destination: "form" | "site"; // default "form"
  landingUrl: string; // "" unless destination === "site"
};

/**
 * One audience inside a "Launch New" batch. Each becomes its own PAUSED ad set in the campaign;
 * ads are split across audiences via AdRow.audienceIds. `name` is the ad-set name (auto from the
 * targeting until the user types one). `presetId` tracks which saved preset (if any) it matches.
 */
export type AudienceSet = {
  id: string;
  name: string;
  nameEdited: boolean;
  audience: LaunchAudience;
  presetId: string | null;
};

/**
 * Handoff from the Ad-Set Board (the drag-and-drop step before the review table) into AdSetup.
 * The board writes each ad's ad-set assignment straight onto the rows (audienceIds for New, adSetIds
 * for Existing); this seed carries the launch-wide ad-set config so the table opens pre-configured.
 * Everything downstream (payload builder, /api/launches/create) is unchanged — the board just
 * front-loads the same assignment the table already understands.
 */
export type BoardSeed = {
  adSetMode: "existing" | "new";
  // The board's live lead-form library — includes forms built (or excludes ones deleted) on the board,
  // which the server-loaded list doesn't know about yet. Without this the table can't resolve a new
  // form's name and its picker looks empty even though the rows carry the id.
  leadForms?: Option[];
  // New-ad-set launches only (one AudienceSet per board column):
  audiences?: AudienceSet[];
  campaignMode?: "new" | "existing";
  campaignId?: string | null;
  campaignName?: string;
  budget?: string;
  budgetMode?: "cbo" | "abo";
};

/** A saved audience/settings preset (the `ad_presets` row, camelCased). */
export type Preset = {
  id: string;
  name: string;
  countries: string[];
  ageMin: number;
  ageMax: number;
  genders: number[] | null;
  advantageAudience: boolean;
  publisherPlatforms: string[];
  defaultCta: string;
  defaultFormTemplateId: string | null;
  extra: {
    placements?: string[];
    optimizationGoal?: string;
    attributionDays?: number;
    scheduleStart?: string;
    scheduleEnd?: string;
    destination?: "form" | "site";
    landingUrl?: string;
  } | null;
};

/** Reference data (loaded server-side) used to populate the Ad Setup dropdowns. */
export type AdSetupData = {
  pages: Option[];
  instagram: Option[];
  whatsapp: Option[];
  adSetTree: AdSetGroup[];
  leadForms: Option[];
  presets: Preset[];
  defaultWebsiteUrl: string; // the standard destination (Settings → Default website URL) — pre-fills landing/after-submit + the Link mirror
};

/** One row of Launch History (a past launch batch), as loaded from `ad_launches`. */
export type LaunchRow = {
  id: string;
  name: string;
  status: string; // DRAFT | LAUNCHING | PAUSED | PARTIAL | CANCELLED | FAILED (C20)
  format: string | null;
  adCount: number;
  thumbUrls: string[];
  createdAt: string;
  launchedAt: string | null;
  lastError?: string | null; // why the last launch attempt failed (shown on the entry); null when it succeeded
  // ACTIVE | PAUSED | MIXED — the launch's ads' CURRENT status on Meta, refreshed by the sync. `status`
  // above is what the launch created (always paused); this is what those ads are doing now.
  liveStatus?: string | null;
  totalAds?: number | null; // total ads in a batched launch (for the "Launching X/Y" progress readout)
  nextBatchAt?: string | null; // when the next batch is due (pending.nextAt) — drives the live progress popup countdown
};
