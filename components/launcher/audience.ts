// Audience / ad-set settings helpers for the launcher's "Launch New" flow. Client + server safe.
import type { LaunchAudience, AudienceSet, Preset } from "./types";

export const COUNTRIES: { code: string; name: string }[] = [
  { code: "PT", name: "Portugal" },
  { code: "ES", name: "Spain" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "IT", name: "Italy" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "NL", name: "Netherlands" },
  { code: "US", name: "United States" },
  { code: "BR", name: "Brazil" },
];

export const OPTIMIZATION_GOALS: { id: string; name: string }[] = [
  { id: "LEAD_GENERATION", name: "Maximize leads (standard)" },
  { id: "QUALITY_LEAD", name: "Higher-intent leads" },
];

export const ATTRIBUTION_OPTIONS: { id: number; name: string }[] = [
  { id: 1, name: "1-day click" },
  { id: 7, name: "7-day click" },
];

/** The proven default setup — what the launcher uses out of the box (PT · 29–65 · FB+IG · lead-gen). */
export const DEFAULT_AUDIENCE: LaunchAudience = {
  countries: ["PT"],
  ageMin: 29,
  ageMax: 65,
  genders: null,
  advantageAudience: false,
  facebook: true,
  instagram: true,
  placements: [],
  optimizationGoal: "LEAD_GENERATION",
  attributionDays: 1,
  scheduleStart: "",
  scheduleEnd: "",
  destination: "form",
  landingUrl: "",
};

/** Build a launch audience from a saved preset (defaults fill any gaps). */
export function audienceFromPreset(p: Preset): LaunchAudience {
  const platforms = p.publisherPlatforms?.length ? p.publisherPlatforms : ["facebook", "instagram"];
  return {
    countries: p.countries?.length ? p.countries : ["PT"],
    ageMin: p.ageMin ?? 29,
    ageMax: p.ageMax ?? 65,
    genders: p.genders ?? null,
    advantageAudience: !!p.advantageAudience,
    facebook: platforms.includes("facebook"),
    instagram: platforms.includes("instagram"),
    placements: p.extra?.placements ?? [],
    optimizationGoal: p.extra?.optimizationGoal ?? "LEAD_GENERATION",
    attributionDays: p.extra?.attributionDays ?? 1,
    scheduleStart: p.extra?.scheduleStart ?? "",
    scheduleEnd: p.extra?.scheduleEnd ?? "",
    destination: p.extra?.destination === "site" ? "site" : "form",
    landingUrl: p.extra?.landingUrl ?? "",
  };
}

/** A locally-unique id for an AudienceSet (browser + node safe). */
let audSeq = 0;
function localId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `aud_${++audSeq}_${Math.round(performance?.now?.() ?? 0)}`;
}

/** Wrap an audience into an AudienceSet, auto-naming it from the targeting unless a name is given. */
export function makeAudienceSet(audience: LaunchAudience, presetId: string | null = null, name?: string): AudienceSet {
  return { id: localId(), name: (name ?? "").trim() || adSetNameFor(audience), nameEdited: !!name, audience, presetId };
}

// Separator for generated names — a plain hyphen (not a middle dot) so the format is easy to retype by hand.
const SEP = " - ";

/** Auto-generated campaign name from the audience (descriptive style, e.g. "Leads - PT 29–65"). */
export function campaignNameFor(a: LaunchAudience): string {
  const where = a.countries.length ? a.countries.join("/") : "PT";
  return `Leads${SEP}${where} ${a.ageMin}–${a.ageMax}`;
}

/** Auto-generated ad-set name from the audience (e.g. "PT - 29–65 - FB+IG - Form", "… - Landing"). */
export function adSetNameFor(a: LaunchAudience): string {
  const where = a.countries.length ? a.countries.join("/") : "PT";
  const who = a.genders == null ? "" : a.genders.includes(1) ? `${SEP}Men` : `${SEP}Women`;
  const plat = [a.facebook ? "FB" : null, a.instagram ? "IG" : null].filter(Boolean).join("+") || "—";
  const dest = a.destination === "site" ? "Landing" : "Form";
  return `${where}${SEP}${a.ageMin}–${a.ageMax}${who}${SEP}${plat}${SEP}${dest}`;
}

/** A short one-line summary of an audience (shown in the Launch New panel). */
export function audienceSummary(a: LaunchAudience): string {
  const where = a.countries.length ? a.countries.join(", ") : "—";
  const who = a.genders == null ? "All" : a.genders.includes(1) ? "Men" : "Women";
  const plat = [a.facebook && "FB", a.instagram && "IG"].filter(Boolean).join("+") || "—";
  return `${where}${SEP}${a.ageMin}–${a.ageMax}${SEP}${who}${SEP}${plat}`;
}

/** The POST body for saving an audience as a preset (matches /api/presets). */
export function presetPayload(name: string, a: LaunchAudience, defaultCta: string, defaultFormTemplateId: string | null) {
  return {
    name,
    countries: a.countries,
    ageMin: a.ageMin,
    ageMax: a.ageMax,
    genders: a.genders ?? [],
    advantageAudience: a.advantageAudience,
    publisherPlatforms: [a.facebook ? "facebook" : null, a.instagram ? "instagram" : null].filter(Boolean),
    defaultCta,
    defaultFormTemplateId,
    extra: {
      placements: a.placements,
      optimizationGoal: a.optimizationGoal,
      attributionDays: a.attributionDays,
      scheduleStart: a.scheduleStart,
      scheduleEnd: a.scheduleEnd,
      destination: a.destination,
      landingUrl: a.landingUrl,
    },
  };
}
