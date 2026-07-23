"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { ArrowLeftIcon, XIcon, ColumnsIcon, RocketIcon, TrashIcon, CopyIcon, PlusIcon, LayersIcon } from "../icons";
import { Select } from "./Select";
import { LeadFormPicker } from "./LeadFormPicker";
import { ColumnPicker, COLS_STORAGE_KEY } from "./ColumnPicker";
import { LeavePrompt } from "./LeavePrompt";
import { BulkEditMenu, BulkEditModal, type BulkField } from "./BulkEdit";
import { ConvertModal } from "./ConvertModal";
import { AddAdsModal } from "./AddAdsModal";
import { FormatCell, Toggle, MediaCell, TextCell, VariationCell, AdSetsCell, AudienceCell, RowCheck } from "./cells";
import {
  CTA_OPTIONS,
  COLUMN_LABEL,
  COLUMN_WIDTH,
  COLUMN_ORDER,
  DEFAULT_VISIBLE,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  allowsVariations,
} from "./constants";
import { LaunchSettingsModal } from "./LaunchSettingsModal";
import { LeadFormBuilderModal } from "./LeadFormBuilderModal";
import { PreviewModal } from "./PreviewModal";
import { CropModal } from "./CropModal";
import { LaunchProgress, type LaunchStage } from "./LaunchProgress";
import { LaunchPlanModal, type PlanShape } from "./LaunchPlanModal";
import { DEFAULT_AUDIENCE, audienceFromPreset, audienceSummary, campaignNameFor, adSetNameFor, makeAudienceSet } from "../audience";
import { useBodyScrollLock } from "../useBodyScrollLock";
import { ratioLabel } from "../ratio";
import { createClient } from "@/lib/supabase/client";
import type { AdRow, ColumnKey, UploadedCreative, AdSetupData, LaunchAudience, AudienceSet, Preset, BoardSeed } from "../types";

const newDupId = () => `dup_${crypto.randomUUID()}`; // collision-proof so a duplicate can't clash with a resumed draft's ids (C49)

/** Measure an image creative's aspect-ratio label (for Multi-Ratio placement mapping). */
function measureRatio(c: UploadedCreative): Promise<string> {
  return new Promise((resolve) => {
    if (c.kind !== "image") return resolve("");
    const img = new window.Image();
    img.onload = () => resolve(ratioLabel(img.naturalWidth, img.naturalHeight));
    img.onerror = () => resolve("");
    img.src = c.previewUrl;
  });
}

/** Turn the user's normalized Feed crop (0–1 of the image) into Meta image_crops (pixel rects per ratio). */
async function feedCropToImageCrops(c: UploadedCreative, crop: NonNullable<AdRow["feedCrop"]>): Promise<Record<string, number[][]> | undefined> {
  const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = c.previewUrl;
  });
  if (!dims) return undefined;
  const x1 = Math.round(crop.x * dims.w), y1 = Math.round(crop.y * dims.h);
  const x2 = Math.round((crop.x + crop.w) * dims.w), y2 = Math.round((crop.y + crop.h) * dims.h);
  const out: Record<string, number[][]> = { "400x500": [[x1, y1], [x2, y2]] }; // 4:5 Feed
  // A centered square inside that region for 1:1 placements.
  const side = Math.min(x2 - x1, y2 - y1);
  const cx = Math.round((x1 + x2) / 2), cy = Math.round((y1 + y2) / 2);
  const sx = Math.max(0, Math.min(dims.w - side, cx - Math.round(side / 2)));
  const sy = Math.max(0, Math.min(dims.h - side, cy - Math.round(side / 2)));
  out["100x100"] = [[sx, sy], [sx + side, sy + side]];
  return out;
}

/**
 * Downscale an image File to a small JPEG DATA URL for the launch-history preview. Self-contained (no storage
 * dependency) so it survives the post-launch image cleanup and never expires — unlike the signed URLs drafts use.
 */
function fileToThumb(file: File, max = 640): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight) || 1);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

const LAUNCH_THUMB_CAP = 16; // durable thumbnails stored per launch (one per ad, in order) — bounds the history-list payload

function loadVisibleColumns(): ColumnKey[] {
  if (typeof window === "undefined") return DEFAULT_VISIBLE;
  try {
    const raw = window.localStorage.getItem(COLS_STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((c) => COLUMN_ORDER.includes(c)) as ColumnKey[];
      return Array.from(new Set([...REQUIRED_COLUMNS, ...valid]));
    }
  } catch {
    // ignore
  }
  return DEFAULT_VISIBLE;
}

export type DraftContext = {
  id: string;
  adSetMode: "existing" | "new";
  campaignName: string;
  budget: string;
  draftKey?: string;
  audiences?: AudienceSet[]; // multi-audience drafts
  audience?: LaunchAudience; // legacy single-audience drafts (back-compat)
  presetId?: string | null; // legacy
  adSetName?: string; // legacy
  campaignMode?: "new" | "existing";
  campaignId?: string | null;
  budgetMode?: "cbo" | "abo";
  // "One ad set per folder" mode: whether it's on, per-bucket name overrides, and which buckets are excluded.
  structured?: boolean;
  bucketNames?: Record<string, string>;
  excludedBuckets?: string[];
};

export function AdSetup({
  rows,
  setRows,
  creatives,
  data,
  onExit,
  onAddAds,
  draft,
  seed,
  namingIds,
}: {
  rows: AdRow[];
  setRows: React.Dispatch<React.SetStateAction<AdRow[]>>;
  creatives: UploadedCreative[];
  data: AdSetupData;
  onExit: () => void;
  onAddAds: (creatives: UploadedCreative[]) => void;
  draft?: DraftContext; // when reopening a saved draft — restores ad-set choice + overwrites on re-save
  seed?: BoardSeed; // when arriving from the ad-set board — pre-fills the ad-set config (rows already assigned)
  namingIds?: Set<string>; // rows whose name is being auto-generated from the image (shows a spinner)
}) {
  const router = useRouter();
  useBodyScrollLock(); // pin the page behind this full-screen overlay
  // Folder-import: any row carrying a bucket means the launch can be split into "one ad set per folder".
  const hasBuckets = rows.some((r) => !!r.bucket);
  const [visible, setVisible] = useState<ColumnKey[]>(loadVisibleColumns);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showCols, setShowCols] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null); // a nav link the user clicked while in setup
  // Arriving from the ad-set board (seed) → use its config. Else a resumed draft, else folder imports
  // default to Launch New (they need fresh ad sets, one per folder).
  const [adSetMode, setAdSetMode] = useState<"existing" | "new">(seed?.adSetMode ?? draft?.adSetMode ?? (hasBuckets ? "new" : "existing"));
  const [newCampaignName, setNewCampaignName] = useState(seed?.campaignName ?? draft?.campaignName ?? "");
  const [newBudget, setNewBudget] = useState(seed?.budget ?? draft?.budget ?? "");
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
  // Editable audiences for "Launch New" — one ad set each. Seeded from the draft, or one default audience.
  const initialPreset = data.presets[0] ?? null;
  const [presets, setPresets] = useState<Preset[]>(data.presets);
  const defaultWebsiteUrl = data.defaultWebsiteUrl || "";
  // Pre-fill an audience's destination URL with the company default so it's visible + never blank/privacy.
  const withDefaultUrl = (a: LaunchAudience): LaunchAudience => ({ ...a, landingUrl: (a.landingUrl || "").trim() || defaultWebsiteUrl });
  const [audiences, setAudiences] = useState<AudienceSet[]>(() => {
    if (seed?.audiences?.length) return seed.audiences; // one per board column, rows already assigned to them
    if (draft?.audiences?.length) return draft.audiences;
    if (draft?.audience) return [makeAudienceSet(draft.audience, draft.presetId ?? null, draft.adSetName)];
    return [makeAudienceSet(withDefaultUrl(initialPreset ? audienceFromPreset(initialPreset) : DEFAULT_AUDIENCE), initialPreset?.id ?? null)];
  });
  const [editingAudId, setEditingAudId] = useState<string | null>(null); // which audience the settings modal edits
  // Destination for "Launch New": the new ad set goes into a NEW campaign or an EXISTING one.
  const [campaignMode, setCampaignMode] = useState<"new" | "existing">(seed?.campaignMode ?? draft?.campaignMode ?? "new");
  const [campaignId, setCampaignId] = useState<string | null>(seed?.campaignId ?? draft?.campaignId ?? null);
  // ABO by default — a fixed, fair budget per ad set (a clean creative test). Seed/draft can override.
  const [budgetMode, setBudgetMode] = useState<"cbo" | "abo">(seed?.budgetMode ?? draft?.budgetMode ?? "abo");
  // "One ad set per folder" mode + its per-bucket name overrides and exclusions (e.g. drop the Notes folders).
  // Off when seeded from the board — the board already resolved folders into columns + per-row assignment.
  const [structured, setStructured] = useState<boolean>(draft?.structured ?? (seed ? false : hasBuckets));
  const [bucketNames, setBucketNames] = useState<Record<string, string>>(draft?.bucketNames ?? {});
  const [excludedBuckets, setExcludedBuckets] = useState<Set<string>>(() => {
    if (draft?.excludedBuckets) return new Set(draft.excludedBuckets);
    // Auto-exclude the iPhone-notes folders by default — they're rarely part of a Design-vs-Text test.
    const ex = new Set<string>();
    for (const r of rows) if (r.bucket && /notes/i.test(r.bucketName || "")) ex.add(r.bucket);
    return ex;
  });
  // Campaign name auto-fills from the first audience until the user overrides it (a seeded/draft name counts as set).
  const [campaignNameEdited, setCampaignNameEdited] = useState(!!(seed?.campaignName || draft?.campaignName));
  const firstAudience = audiences[0]?.audience ?? DEFAULT_AUDIENCE;
  useEffect(() => {
    if (!campaignNameEdited) setNewCampaignName(campaignNameFor(firstAudience));
  }, [firstAudience, campaignNameEdited]);

  // Guard against leaving the Ad Setup sheet with unsaved work. Intercept in-app nav clicks (sidebar
  // tabs etc.) and show the "Leave Ad Setup?" prompt instead of silently navigating away. `beforeunload`
  // covers hard reloads / tab close (a generic browser warning). A leave is only finalised via the prompt.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("/") || href.startsWith("//")) return; // only internal app routes
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(href);
      setLeaving(true);
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    document.addEventListener("click", onDocClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // ----- Audience management (Launch New) -----
  const updateAudienceById = (id: string, fn: (s: AudienceSet) => AudienceSet) => setAudiences((as) => as.map((s) => (s.id === id ? fn(s) : s)));
  const setAudienceFor = (id: string, a: LaunchAudience) => updateAudienceById(id, (s) => ({ ...s, audience: a, name: s.nameEdited ? s.name : adSetNameFor(a) }));
  const setAudienceNameFor = (id: string, n: string) => updateAudienceById(id, (s) => ({ ...s, name: n, nameEdited: true }));
  const setAudiencePresetFor = (id: string, pid: string | null) => updateAudienceById(id, (s) => ({ ...s, presetId: pid }));
  function addAudience() {
    const base = audiences[0]?.audience ?? DEFAULT_AUDIENCE;
    const seed = makeAudienceSet({ ...base }, null, `Audience ${audiences.length + 1}`);
    setAudiences((as) => [...as, seed]);
    setEditingAudId(seed.id);
  }
  function duplicateAudience(id: string) {
    const src = audiences.find((s) => s.id === id);
    if (!src) return;
    const copy = makeAudienceSet({ ...src.audience }, src.presetId, `${src.name} (copy)`);
    setAudiences((as) => {
      const i = as.findIndex((s) => s.id === id);
      const next = [...as];
      next.splice(i + 1, 0, copy);
      return next;
    });
  }
  function deleteAudience(id: string) {
    if (audiences.length <= 1) return;
    setAudiences((as) => as.filter((s) => s.id !== id));
    setRows((rs) => rs.map((r) => (r.audienceIds.includes(id) ? { ...r, audienceIds: r.audienceIds.filter((x) => x !== id) } : r)));
  }
  // How many ads a row produces in Launch New = how many audiences it targets (empty = all).
  const assignedCount = (r: AdRow) => {
    const valid = r.audienceIds.filter((id) => audiences.some((s) => s.id === id));
    return valid.length || audiences.length;
  };
  // Mirrors the server's usesAssetFeed(ad, launchingNew=true) (lib/launch.ts:150): an ad with 2+ copy
  // variations — or any Flexible/Multi-Ratio ad — is built as Dynamic Creative, and Meta only allows ONE
  // ad in a Dynamic Creative ad set, so it gets a dedicated ad set instead of sharing its audience's.
  const isAssetFeedRow = (r: AdRow): boolean => {
    if (r.format === "flexible" || r.format === "multi_ratio") return true;
    if (r.format !== "single") return false;
    if (r.creativeIds.some((id) => byId.get(id)?.kind === "video")) return false; // video keeps the first copy only
    const n = (xs: string[]) => xs.map((s) => (s || "").trim()).filter(Boolean).length;
    return n(r.primaryText) > 1 || n(r.headline) > 1 || n(r.description) > 1;
  };
  const stripVars = (r: AdRow): AdRow => ({ ...r, primaryText: [r.primaryText[0] ?? ""], headline: [r.headline[0] ?? ""], description: [r.description[0] ?? ""] });
  // What this launch really creates: plain ads share one ad set per audience; Dynamic Creative ads get one
  // each. `strip` models the "first copy only" choice. perDay is null when the budget isn't ours (existing campaign).
  const planCounts = (strip: boolean) => {
    const audsFor = (r: AdRow) => {
      const valid = r.audienceIds.filter((id) => audiences.some((a) => a.id === id));
      return valid.length ? valid : audiences.map((a) => a.id);
    };
    const shared = new Set<string>();
    let dedicated = 0;
    let ads = 0;
    for (const r of rows) {
      const list = audsFor(r);
      ads += list.length;
      if (!strip && isAssetFeedRow(r)) dedicated += list.length;
      else list.forEach((id) => shared.add(id));
    }
    const adSets = shared.size + dedicated;
    const b = Number(newBudget);
    const perDay = campaignMode === "existing" || !(b > 0) ? null : budgetMode === "abo" ? adSets * b : b;
    return { adSets, ads, perDay };
  };
  // The destination URL(s) an ad lands on, resolved from the audiences it runs in — for the read-only Link mirror.
  // A landing-page audience → its URL; an instant-form audience → its after-submit redirect (both live in landingUrl).
  const rowDestination = (r: AdRow): string => {
    const auds = r.audienceIds.length ? audiences.filter((s) => r.audienceIds.includes(s.id)) : audiences;
    const urls = Array.from(new Set(auds.map((s) => (s.audience.landingUrl || "").trim() || defaultWebsiteUrl).filter(Boolean)));
    if (urls.length <= 1) return urls[0] ?? defaultWebsiteUrl;
    return `${urls.length} destinations`;
  };
  // ----- Folder buckets ("one ad set per folder" mode) -----
  // Distinct folder buckets in the table (first-appearance order). Name = rename override → derived label.
  const buckets = (() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const r of rows) {
      if (!r.bucket) continue;
      const e = m.get(r.bucket);
      if (e) e.count++;
      else m.set(r.bucket, { id: r.bucket, name: bucketNames[r.bucket] ?? r.bucketName ?? r.bucket, count: 1 });
    }
    return [...m.values()];
  })();
  const includedBuckets = buckets.filter((b) => !excludedBuckets.has(b.id));
  // On when the user is in Launch New with folder buckets and hasn't switched the mode off.
  const structuredActive = adSetMode === "new" && structured && hasBuckets;
  // The rows that will actually launch in structured mode (skip excluded buckets / bucket-less rows).
  const structuredRows = rows.filter((r) => r.bucket && !excludedBuckets.has(r.bucket));
  const bucketLabel = (id: string | null | undefined): string => (id ? buckets.find((x) => x.id === id)?.name ?? id : "");
  const setBucketName = (id: string, name: string) => setBucketNames((m) => ({ ...m, [id]: name }));
  const toggleBucket = (id: string) => setExcludedBuckets((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Structured mode: one shared primary text / headline applied to EVERY folder's ads at once.
  const setAllBucketCopy = (field: "primaryText" | "headline", v: string) => setRows((rs) => rs.map((r) => (r.bucket ? { ...r, [field]: [v] } : r)));

  // Lead forms are stateful so a form built in-grid appears in every row's picker immediately. Seeded from
  // the board when we came from it — its list already includes anything built (or dropped) there.
  const [leadForms, setLeadForms] = useState(seed?.leadForms ?? data.leadForms);
  const [formBuilderRow, setFormBuilderRow] = useState<string | null>(null);
  const [formBuilderEditId, setFormBuilderEditId] = useState<string | null>(null);
  const [previewRow, setPreviewRow] = useState<string | null>(null);
  const [cropRow, setCropRow] = useState<string | null>(null); // which row's "Frame for Feed" crop tool is open

  // Handles every builder outcome: new save, update, save-as-new, and "use once" (id is "meta:<id>").
  // Dedupe by id so an updated/renamed form replaces its old option rather than duplicating it.
  function onFormDone(form: { id: string; name: string }) {
    setLeadForms((fs) => [form, ...fs.filter((f) => f.id !== form.id)]);
    if (formBuilderRow) patch(formBuilderRow, { leadFormId: form.id });
    setFormBuilderRow(null);
    setFormBuilderEditId(null);
  }
  const closeFormBuilder = () => { setFormBuilderRow(null); setFormBuilderEditId(null); };
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchStage, setLaunchStage] = useState<LaunchStage>("upload");
  const [uploadDone, setUploadDone] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [plan, setPlan] = useState<null | { variationAds: number; withVars: PlanShape; stripped: PlanShape }>(null);
  const [bulkField, setBulkField] = useState<BulkField | null>(null);
  const [showConvert, setShowConvert] = useState(false);
  const [showAddAds, setShowAddAds] = useState(false);

  const byId = new Map(creatives.map((c) => [c.id, c]));
  // Destination-aware columns (Launch New only): the Link column mirrors every ad's destination, and the Lead
  // Form picker appears only when at least one audience uses an instant form. Existing mode = column-picker driven.
  const launchNew = adSetMode === "new";
  const anyFormAudience = audiences.some((s) => s.audience.destination !== "site");
  const visibleSet = new Set<ColumnKey>(visible);
  if (launchNew) {
    visibleSet.add("link");
    if (anyFormAudience) visibleSet.add("leadForm");
    else visibleSet.delete("leadForm");
  }
  const cols = COLUMN_ORDER.filter((c) => REQUIRED_COLUMNS.includes(c) || visibleSet.has(c));

  function patch(id: string, p: Partial<AdRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }
  function toggleSel(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }
  function duplicateSelected() {
    setRows((rs) => {
      const out: AdRow[] = [];
      for (const r of rs) {
        out.push(r);
        if (selected.has(r.id)) out.push({ ...r, id: newDupId(), name: `${r.name} (copy)` });
      }
      return out;
    });
    setSelected(new Set());
  }
  function deleteSelected() {
    setRows((rs) => rs.filter((r) => !selected.has(r.id)));
    setSelected(new Set());
  }

  function applyBulk(fn: (row: AdRow) => Partial<AdRow>) {
    setRows((rs) => rs.map((r) => (selected.has(r.id) ? { ...r, ...fn(r) } : r)));
    setBulkField(null);
  }

  // Convert the whole launch to multi-ratio (formats can't be mixed), keeping the first copy variation.
  function convertAll() {
    setRows((rs) => rs.map((r) => ({ ...r, format: "multi_ratio", primaryText: [r.primaryText[0] ?? ""], headline: [r.headline[0] ?? ""], description: [r.description[0] ?? ""] })));
    setShowConvert(false);
    setSelected(new Set());
  }

  const canConvert = rows.length > 0 && (rows[0].format === "single" || rows[0].format === "flexible");

  async function saveDraft(nextHref: string | null = null) {
    if (saving) return;
    setSaving(true);
    try {
      // Upload each creative to Storage so the draft can be fully reopened later (media included).
      const supabase = createClient();
      // Reuse the folder when overwriting a resumed draft so old media isn't orphaned in Storage.
      const draftKey = draft?.draftKey ?? crypto.randomUUID();
      const used = Array.from(new Map(rows.flatMap((r) => r.creativeIds).map((id) => byId.get(id)).filter((c): c is UploadedCreative => !!c).map((c) => [c.id, c])).values());
      const manifest: { id: string; name: string; kind: string; path: string; type: string; size: number }[] = [];
      const thumbUrls: string[] = [];
      for (const c of used) {
        const ext = c.file.name.match(/\.[^.]+$/)?.[0] || (c.kind === "video" ? ".mp4" : ".png");
        const path = `drafts/${draftKey}/${c.id}${ext}`;
        const up = await supabase.storage.from("launch-media").upload(path, c.file, { upsert: true, contentType: c.file.type || undefined });
        if (up.error) throw up.error;
        manifest.push({ id: c.id, name: c.name, kind: c.kind, path, type: c.file.type || "", size: c.size });
        // Thumbnails for the history row (image creatives only; signed since the bucket is private).
        if (c.kind === "image" && thumbUrls.length < 3) {
          const { data: signed } = await supabase.storage.from("launch-media").createSignedUrl(path, 60 * 60 * 24 * 30);
          if (signed?.signedUrl) thumbUrls.push(signed.signedUrl);
        }
      }
      // Save EVERYTHING so reopening restores the table exactly: rows, media, ad-set choice, campaign + budget, audiences.
      const draftState = { launchFormat: rows[0]?.format ?? "single", rows, creatives: manifest, adSetMode, newCampaignName, newBudget, audiences, campaignMode, campaignId, budgetMode, structured, bucketNames, excludedBuckets: [...excludedBuckets] };
      const name = (adSetMode === "new" && newCampaignName.trim()) || "Draft";
      const res = await fetch("/api/launches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draftId, name, status: "DRAFT", format: rows[0]?.format ?? "single", adCount: rows.length, draftState, thumbUrls }),
      });
      if (!res.ok) throw new Error("save failed");
      const j = await res.json().catch(() => ({}));
      if (j.id) setDraftId(j.id); // so a subsequent save overwrites rather than duplicates
      toast(`Saved as draft · ${rows.length} ad${rows.length === 1 ? "" : "s"}`);
      // If the user was navigating to another tab, continue there; otherwise return to the launcher front page.
      if (nextHref) router.push(nextHref);
      else {
        router.refresh();
        onExit();
      }
    } catch {
      toast("Couldn't save the draft", "error");
      setSaving(false);
    }
  }

  // Create the ads on Meta — all PAUSED (the server hard-codes it).
  async function launch(opts?: { force?: boolean; strip?: boolean }) {
    if (launching) return;
    if (adSetMode === "existing") {
      if (rows.some((r) => r.adSetIds.length === 0)) {
        toast("Pick at least one ad set for every ad");
        return;
      }
      if (rows.some((r) => r.format !== "single" && r.format !== "carousel")) {
        toast("Flexible & Multi-Ratio need 'Launch New' — each needs its own ad set", "error");
        return;
      }
    } else {
      if (campaignMode === "new") {
        if (!newCampaignName.trim()) {
          toast("Name the new campaign");
          return;
        }
        if (!(Number(newBudget) >= 1)) {
          toast("Set a daily budget of at least €1");
          return;
        }
      } else if (!campaignId) {
        toast("Pick a campaign for the new ad set");
        return;
      }
      if (structuredActive) {
        if (includedBuckets.length === 0 || structuredRows.length === 0) {
          toast("Select at least one folder to launch");
          return;
        }
        const a = audiences[0]?.audience;
        if (a && !a.facebook && !a.instagram) { toast("Turn on Facebook or Instagram"); setEditingAudId(audiences[0].id); return; }
        if (a && a.destination === "site" && !a.landingUrl.trim()) { toast("Add a landing-page URL"); setEditingAudId(audiences[0].id); return; }
      } else {
        for (const s of audiences) {
          if (!s.audience.facebook && !s.audience.instagram) {
            toast(`Turn on Facebook or Instagram for "${s.name}"`);
            setEditingAudId(s.id);
            return;
          }
          if (s.audience.destination === "site" && !s.audience.landingUrl.trim()) {
            toast(`Add a landing-page URL for "${s.name}"`);
            setEditingAudId(s.id);
            return;
          }
        }
      }
    }
    if (rows.some((r) => r.format !== "single" && r.creativeIds.some((id) => byId.get(id)?.kind === "video"))) {
      toast("Video is only supported for single ads right now", "error");
      return;
    }
    const totalAds =
      adSetMode === "existing"
        ? rows.reduce((n, r) => n + r.adSetIds.length, 0)
        : structuredActive
        ? structuredRows.length
        : rows.reduce((n, r) => n + assignedCount(r), 0);
    // Copy variations only actually launch for Flexible (always) and for single-IMAGE ads via Launch New.
    // A single ad drops all but the first variation when it goes into an existing ad set OR when its
    // creative is a video — warn in either case so the dialog never implies variations that won't run.
    const droppingVariations = rows.some((r) => {
      if (r.format !== "single") return false; // flexible carries them; multi/carousel can't have them
      const hasVars = [r.primaryText, r.headline, r.description].some((arr) => arr.filter((v) => v.trim()).length > 1);
      if (!hasVars) return false;
      const isVideo = r.creativeIds.some((id) => byId.get(id)?.kind === "video");
      const willRunAll = adSetMode === "new" && !isVideo; // single-image via Launch New = asset feed
      return !willRunAll;
    });
    const note = droppingVariations
      ? ' (Single ads launch only the first copy variation unless they\'re images via "Launch New" — video ads and existing-ad-set launches use the first only.)'
      : "";
    // Copy variations force Dynamic Creative, and a Dynamic Creative ad set holds exactly ONE ad — so those
    // ads each get their own ad set, silently replacing the grouping the user built. Spell it out and let
    // them choose (the modal is the confirmation, so `force` skips the plain confirm below).
    if (!opts?.force && adSetMode === "new" && !structuredActive && rows.some(isAssetFeedRow)) {
      setPlan({ variationAds: rows.filter(isAssetFeedRow).length, withVars: planCounts(false), stripped: planCounts(true) });
      return;
    }

    const where = adSetMode === "new" ? ` into a new paused campaign "${newCampaignName.trim()}"` : "";
    if (!opts?.force && !confirm(`Create ${totalAds} ad${totalAds === 1 ? "" : "s"}${where}? They'll be added PAUSED — nothing goes live until you turn them on yourself.${note}`)) return;

    setLaunching(true);
    setLaunchStage("upload");
    setUploadDone(0);
    try {
      // In "one ad set per folder" mode, only the included buckets' rows launch (excluded folders are dropped).
      // `strip` = the user chose "first copy only" so their ad-set grouping survives (see the plan modal).
      const effRows = (structuredActive ? structuredRows : rows).map((r) => (opts?.strip ? stripVars(r) : r));
      // Pre-upload videos straight to Storage → Meta so large files never hit the JSON payload / body limit.
      const dedup = (kind: "image" | "video") =>
        Array.from(new Map(effRows.flatMap((r) => r.creativeIds).map((id) => byId.get(id)).filter((c): c is UploadedCreative => !!c && c.kind === kind).map((c) => [c.id, c])).values());
      const vids = dedup("video");
      const imgs = dedup("image");
      setUploadTotal(vids.length + imgs.length);
      const videoIdByCreative = new Map<string, string>();
      if (vids.length) {
        const supabase = createClient();
        for (const c of vids) {
          const path = `videos/${crypto.randomUUID()}.mp4`;
          const up = await supabase.storage.from("launch-media").upload(path, c.file, { upsert: true, contentType: c.file.type || "video/mp4" });
          if (up.error) { toast(`Couldn't upload video "${c.name}"`, "error"); setLaunching(false); return; }
          const res = await fetch("/api/launches/upload-video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.videoId) { toast(j.error || `Video "${c.name}" failed to process`, "error"); setLaunching(false); return; }
          videoIdByCreative.set(c.id, j.videoId);
          setUploadDone((n) => n + 1);
        }
      }

      // Upload images to Storage IN PARALLEL — in-flight uploads keep going even if you switch tabs. We hand
      // the server the storage paths; it uploads them to Meta and creates ALL the ads itself (in the background),
      // so the launch finishes server-side whether or not this tab stays open.
      const imagePathByCreative = new Map<string, string>();
      if (imgs.length) {
        const supabase = createClient();
        const ups = await Promise.all(
          imgs.map(async (c) => {
            const ext = c.file.name.match(/\.[^.]+$/)?.[0] || ".png";
            const path = `launch-images/${crypto.randomUUID()}${ext}`;
            const up = await supabase.storage.from("launch-media").upload(path, c.file, { upsert: true, contentType: c.file.type || "image/png" });
            setUploadDone((n) => n + 1);
            return { id: c.id, name: c.name, path: up.error ? null : path };
          })
        );
        const bad = ups.find((u) => !u.path);
        if (bad) { toast(`Couldn't upload "${bad.name}"`, "error"); setLaunching(false); return; }
        for (const u of ups) imagePathByCreative.set(u.id, u.path!);
      }

      const payloadRows = await Promise.all(
        effRows.map(async (r) => ({
          name: r.name,
          format: r.format,
          primaryText: r.primaryText,
          headline: r.headline,
          description: r.description,
          link: r.link,
          cta: r.cta,
          leadFormId: r.leadFormId,
          imageCrops:
            r.feedCrop && r.format === "single" && byId.get(r.creativeIds[0])?.kind === "image"
              ? await feedCropToImageCrops(byId.get(r.creativeIds[0])!, r.feedCrop)
              : undefined,
          enhancements: r.enhancements,
          utm: r.utm,
          adSetIds: r.adSetIds,
          // Structured mode: this ad goes into the single ad set for its folder (its bucket id).
          audienceIds: structuredActive ? [r.bucket as string] : r.audienceIds, // Launch New: which audiences this ad goes into (empty = all)
          // Videos are pre-uploaded (videoIds); only images travel as base64.
          images: r.creativeIds.map(() => ""), // images travel as storage paths (uploaded to Meta server-side); videos use videoIds
          imagePaths: r.creativeIds.map((id) => imagePathByCreative.get(id) ?? null),
          kinds: r.creativeIds.map((id) => byId.get(id)?.kind ?? "image"),
          ratios: r.format === "multi_ratio" ? await Promise.all(r.creativeIds.map((id) => { const c = byId.get(id); return c ? measureRatio(c) : Promise.resolve(""); })) : [],
          videoIds: r.creativeIds.map((id) => videoIdByCreative.get(id) ?? null),
        }))
      );
      // Durable thumbnails (data URLs) for the launch-history preview — one per ad in order, capped. Stored on
      // the launch record so the history row/preview always show the ads, even after the source images are cleaned.
      const thumbCreatives: UploadedCreative[] = [];
      for (const r of effRows) {
        const c = byId.get(r.creativeIds[0]);
        if (c && c.kind === "image") thumbCreatives.push(c);
        if (thumbCreatives.length >= LAUNCH_THUMB_CAP) break;
      }
      const launchThumbs = (await Promise.all(thumbCreatives.map((c) => fileToThumb(c.file)))).filter((u): u is string => !!u);

      const body: Record<string, any> = { name: adSetMode === "new" ? newCampaignName.trim() : "Launch", rows: payloadRows, draftId: draftId ?? undefined, thumbUrls: launchThumbs };
      if (adSetMode === "new") {
        body.adSetMode = "new";
        body.newAdSet = {
          campaignName: newCampaignName.trim(),
          dailyBudgetEur: Number(newBudget),
          campaignMode,
          // "One ad set per folder": lets the server build the structure up front and drain ads in paced batches.
          structured: structuredActive,
          campaignId: campaignMode === "existing" ? campaignId : undefined,
          // Into an existing campaign the budget lives on that campaign (CBO inherit) — never push a 0-budget ABO ad set.
          budgetMode: campaignMode === "existing" ? "cbo" : budgetMode,
          // One ad set per audience (normal mode) OR one ad set per included folder bucket (structured mode:
          // every bucket shares the SAME targeting/destination, differing only by name + which creatives it holds).
          audiences: (structuredActive
            ? includedBuckets.map((b) => ({ id: b.id, name: b.name, aud: firstAudience }))
            : audiences.map((s) => ({ id: s.id, name: s.name, aud: s.audience }))
          ).map(({ id, name, aud }) => ({
            id,
            name,
            countries: aud.countries,
            ageMin: aud.ageMin,
            ageMax: aud.ageMax,
            genders: aud.genders,
            advantageAudience: aud.advantageAudience,
            facebook: aud.facebook,
            instagram: aud.instagram,
            placements: aud.placements,
            optimizationGoal: aud.optimizationGoal,
            attributionDays: aud.attributionDays,
            destination: aud.destination,
            landingUrl: aud.landingUrl.trim(),
          })),
          // top-level back-compat (first audience's platforms)
          facebook: firstAudience.facebook,
          instagram: firstAudience.instagram,
        };
      }
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 4_000_000) {
        toast("Too much media for one launch — launch fewer ads (or smaller images) at a time", "error");
        setLaunching(false);
        return;
      }
      setLaunchStage("build");
      const res = await fetch("/api/launches/create", { method: "POST", headers: { "content-type": "application/json" }, body: bodyStr });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(j.error || "Couldn't start the launch", "error");
        setLaunching(false);
        return;
      }
      // The server now creates the ads in the BACKGROUND (paced, even if you leave). It shows as "Launching…"
      // in History and flips to "Paused" when done — so you can switch tabs freely.
      toast(`🚀 Launching ${totalAds} ad${totalAds === 1 ? "" : "s"} in the background — switch tabs freely. They'll appear in History (all paused) in a few minutes.`);
      router.refresh();
      await new Promise((r) => setTimeout(r, 400));
      onExit();
    } catch {
      toast("Launch failed", "error");
      setLaunching(false);
    }
  }

  function cell(col: ColumnKey, row: AdRow) {
    switch (col) {
      case "format":
        return <FormatCell format={row.format} />;
      case "status":
        // Everything launches PAUSED (safety). Static, not a toggle — turn ads on later in Ads Manager.
        return (
          <span
            title="Every ad launches paused. Turn them on afterwards from the Ads Manager."
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Paused
          </span>
        );
      case "name":
        return (
          <div className="relative">
            <TextCell value={row.name} onChange={(v) => patch(row.id, { name: v })} placeholder="Ad name" />
            {namingIds?.has(row.id) && (
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" title="Naming from the image…">
                <span className="block h-3.5 w-3.5 animate-spin rounded-full border border-neutral-600 border-t-accent" />
              </span>
            )}
          </div>
        );
      case "media": {
        const firstKind = byId.get(row.creativeIds[0])?.kind;
        return (
          <div className="space-y-1">
            <button
              onClick={() => setPreviewRow(row.id)}
              title="Preview across all placements"
              className="group relative block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <MediaCell creatives={row.creativeIds.map((id) => byId.get(id)).filter((c): c is UploadedCreative => !!c)} />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg text-[10px] font-medium text-transparent transition-colors group-hover:bg-black/55 group-hover:text-white">
                Preview
              </span>
            </button>
            {row.format === "single" && firstKind === "image" && (
              <button onClick={() => setCropRow(row.id)} className="block text-[10px] font-medium text-accent hover:text-accent-600">
                {row.feedCrop ? "✓ Feed framed · edit" : "Frame for Feed"}
              </button>
            )}
          </div>
        );
      }
      case "primaryText":
        return (
          <VariationCell
            values={row.primaryText}
            onChange={(v) => patch(row.id, { primaryText: v })}
            placeholder="Write your primary text..."
            allowVariations={allowsVariations(row.format)}
          />
        );
      case "headline":
        return (
          <VariationCell values={row.headline} onChange={(v) => patch(row.id, { headline: v })} placeholder="Headline..." allowVariations={allowsVariations(row.format)} />
        );
      case "description":
        return (
          <VariationCell
            values={row.description}
            onChange={(v) => patch(row.id, { description: v })}
            placeholder="Description..."
            allowVariations={allowsVariations(row.format)}
          />
        );
      case "link":
        // Launch New: read-only mirror of where the ad sends people (landing page, or the form's after-submit
        // page) — set it per audience in "Edit". Existing mode keeps it editable (the ad carries its own link).
        if (launchNew) {
          const dest = rowDestination(row);
          return <div className="truncate text-xs text-neutral-400" title={dest}>{dest || <span className="text-neutral-600">—</span>}</div>;
        }
        return <TextCell value={row.link} onChange={(v) => patch(row.id, { link: v })} placeholder="https://..." />;
      case "utm":
        return <TextCell value={row.utm} onChange={(v) => patch(row.id, { utm: v })} placeholder="utm_source=..." />;
      case "cta":
        return <Select value={row.cta} onChange={(v) => patch(row.id, { cta: v ?? "LEARN_MORE" })} options={CTA_OPTIONS} placeholder="Select CTA..." />;
      case "facebookPage":
        return <Select value={row.facebookPageId} onChange={(v) => patch(row.id, { facebookPageId: v })} options={data.pages} placeholder="Select page..." searchable />;
      case "instagramPage":
        return <Select value={row.instagramId} onChange={(v) => patch(row.id, { instagramId: v })} options={data.instagram} placeholder="No Instagram accounts" searchable />;
      case "whatsapp":
        return <Select value={row.whatsapp} onChange={(v) => patch(row.id, { whatsapp: v })} options={data.whatsapp} placeholder="No numbers linked" />;
      case "leadForm":
        return (
          <LeadFormPicker
            value={row.leadFormId}
            forms={leadForms}
            onSelect={(id) => patch(row.id, { leadFormId: id })}
            onBuildNew={() => { setFormBuilderEditId(null); setFormBuilderRow(row.id); }}
            onEdit={(id) => { setFormBuilderEditId(id); setFormBuilderRow(row.id); }}
          />
        );
      case "enhancements":
        return (
          <div className="flex items-center gap-2">
            <Toggle on={row.enhancements} onChange={(v) => patch(row.id, { enhancements: v })} label="Creative enhancements" />
            <span className="text-xs text-neutral-500">{row.enhancements ? "On" : "Off"}</span>
          </div>
        );
    }
  }

  const allChecked = rows.length > 0 && selected.size === rows.length;
  const launchCount =
    adSetMode === "existing"
      ? rows.reduce((n, r) => n + r.adSetIds.length, 0)
      : structuredActive
      ? structuredRows.length
      : rows.reduce((n, r) => n + assignedCount(r), 0);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-neutral-950 md:left-60">
      {/* Busy overlay — clear "something is happening" feedback for the slow waits (launch / save). */}
      {(launching || saving) && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-neutral-950/85 px-6 backdrop-blur-sm">
          {launching ? (
            <LaunchProgress stage={launchStage} uploadDone={uploadDone} uploadTotal={uploadTotal} count={launchCount} />
          ) : (
            <>
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
              <div className="text-sm font-medium text-neutral-100">Saving draft…</div>
            </>
          )}
        </div>
      )}
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 bg-panel px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button onClick={() => setLeaving(true)} aria-label="Back" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 bg-transparent text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <span className="truncate text-base font-semibold text-neutral-50">Ads Launcher</span>
          <span className="shrink-0 text-sm text-neutral-500">· {rows.length} ad{rows.length === 1 ? "" : "s"}</span>
          <button
            onClick={() => setShowAddAds(true)}
            className="ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none"
          >
            <PlusIcon className="h-4 w-4" /> Add Ads
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected.size > 0 && (
            <div className="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-1.5 py-1 text-sm">
              <span className="tabular-nums px-2 text-neutral-300">{selected.size} selected</span>
              <BulkEditMenu count={selected.size} onPick={(f) => setBulkField(f)} />
              <button onClick={duplicateSelected} aria-label="Duplicate" className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100">
                <CopyIcon className="h-4 w-4" />
              </button>
              <button onClick={deleteSelected} aria-label="Delete" className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-rose-500/10 hover:text-rose-400">
                <TrashIcon className="h-4 w-4" />
              </button>
              {canConvert && (
                <button
                  onClick={() => setShowConvert(true)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100"
                >
                  <LayersIcon className="h-3.5 w-3.5" /> Multi-Ratio
                </button>
              )}
              <button onClick={() => setSelected(new Set())} className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:text-neutral-200">
                Clear
              </button>
            </div>
          )}
          <button
            onClick={() => setShowCols((s) => !s)}
            aria-label="Choose columns"
            aria-expanded={showCols}
            aria-haspopup="dialog"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 bg-transparent text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none"
          >
            <ColumnsIcon className="h-4 w-4" />
          </button>
          <button onClick={() => setLeaving(true)} aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 bg-transparent text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
            <XIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => void launch()}
            disabled={launching || saving || rows.length === 0}
            className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-3 text-sm font-medium text-[#161616] transition-colors hover:bg-accent-600 disabled:opacity-50 focus-visible:outline-none"
          >
            <RocketIcon className="h-4 w-4" /> {launching ? "Launching…" : "Launch Ads"}
          </button>
        </div>
      </div>

      {/* Table + ad-set setup sidebar. The setup panel lives OUTSIDE the scrolling table: inside the
          table's header row its height inflated the header and pushed every creative row down. */}
      <div className="flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1 overflow-auto">
        <div className="min-w-max">
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-neutral-800 bg-panel">
            <div className="sticky left-0 z-30 flex w-10 items-center justify-center bg-panel py-3">
              <RowCheck checked={allChecked} indeterminate={selected.size > 0 && selected.size < rows.length} onChange={toggleAll} label="Select all" />
            </div>
            {cols.map((c) => (
              <div key={c} style={{ width: COLUMN_WIDTH[c] }} className="mono-label shrink-0 px-3 py-3">
                {COLUMN_LABEL[c]}
              </div>
            ))}
            <div className="sticky right-0 z-30 w-72 shrink-0 border-l border-neutral-800 bg-panel px-4 py-3">
              <span className="mono-label">
                Ad Sets <span className="text-accent">*Required</span>
              </span>
            </div>
          </div>

          {/* Rows */}
          {rows.map((row) => (
            <div key={row.id} className={cn("flex border-b border-neutral-800/60", selected.has(row.id) && "bg-neutral-900")}>
              <div className={cn("sticky left-0 z-10 flex w-10 justify-center py-3", selected.has(row.id) ? "bg-neutral-900" : "bg-neutral-950")}>
                <RowCheck checked={selected.has(row.id)} onChange={() => toggleSel(row.id)} label={`Select ${row.name}`} />
              </div>
              {cols.map((c) => (
                <div key={c} style={{ width: COLUMN_WIDTH[c] }} className="shrink-0 px-3 py-3 align-top">
                  {cell(c, row)}
                </div>
              ))}
              <div className={cn("sticky right-0 z-10 w-72 shrink-0 border-l border-neutral-800 px-4 py-3", selected.has(row.id) ? "bg-neutral-900" : "bg-panel")}>
                {adSetMode === "existing" ? (
                  <AdSetsCell value={row.adSetIds} onChange={(ids) => patch(row.id, { adSetIds: ids })} tree={data.adSetTree} />
                ) : structuredActive ? (
                  row.bucket && !excludedBuckets.has(row.bucket) ? (
                    <div className="truncate rounded-lg border border-dashed border-neutral-800 px-3 py-2 text-xs text-neutral-500" title={bucketLabel(row.bucket)}>Ad set · {bucketLabel(row.bucket)}</div>
                  ) : (
                    <div className="truncate rounded-lg border border-dashed border-neutral-800/60 px-3 py-2 text-xs text-neutral-600">{row.bucket ? "Skipped · folder excluded" : "No folder"}</div>
                  )
                ) : audiences.length > 1 ? (
                  <AudienceCell
                    audiences={audiences.map((s) => ({ id: s.id, name: s.name, destination: s.audience.destination }))}
                    value={row.audienceIds}
                    onChange={(ids) => patch(row.id, { audienceIds: ids })}
                  />
                ) : (
                  <div className="truncate rounded-lg border border-dashed border-neutral-800 px-3 py-2 text-xs text-neutral-600">New ad set · {audiences[0]?.name}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Ad-set setup — full height, its own scroll, independent of the table rows. */}
      <aside className="w-72 shrink-0 overflow-y-auto border-l border-neutral-800 bg-panel px-4 py-3">
        <span className="mono-label">Ad set setup</span>
        <div className="mt-1.5 inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-xs">
          <button onClick={() => setAdSetMode("existing")} className={cn("rounded px-3 py-1 font-medium transition-colors", adSetMode === "existing" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>
            Existing
          </button>
          <button onClick={() => setAdSetMode("new")} className={cn("rounded px-3 py-1 font-medium transition-colors", adSetMode === "new" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>
            Launch New
          </button>
        </div>
        {adSetMode === "new" && (
          <div className="mt-2 space-y-2">
            {/* Campaign: new or existing */}
            <div className="flex items-center justify-between">
              <span className="mono-label">Campaign</span>
              <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-[10px]">
                <button onClick={() => setCampaignMode("new")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", campaignMode === "new" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>New</button>
                <button onClick={() => setCampaignMode("existing")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", campaignMode === "existing" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>Existing</button>
              </div>
            </div>
            {campaignMode === "new" ? (
              <>
                <input
                  value={newCampaignName}
                  onChange={(e) => { setNewCampaignName(e.target.value); setCampaignNameEdited(true); }}
                  placeholder="Campaign name"
                  className="h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
                {/* Budget model: CBO (campaign budget) or ABO (per ad set) */}
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-[10px]">
                    <button onClick={() => setBudgetMode("cbo")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", budgetMode === "cbo" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>CBO</button>
                    <button onClick={() => setBudgetMode("abo")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", budgetMode === "abo" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>ABO</button>
                  </div>
                  <span className="text-[10px] text-neutral-600">{budgetMode === "cbo" ? "Meta splits the budget" : "budget per ad set"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-neutral-500">€</span>
                  <input
                    value={newBudget}
                    onChange={(e) => setNewBudget(e.target.value.replace(/[^0-9.]/g, ""))}
                    inputMode="decimal"
                    placeholder={budgetMode === "cbo" ? "Daily budget" : "Budget / ad set"}
                    className="h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </div>
              </>
            ) : (
              <>
                <Select
                  value={campaignId}
                  onChange={setCampaignId}
                  options={data.adSetTree.map((c) => ({ id: c.campaignId, name: c.campaignName }))}
                  placeholder={data.adSetTree.length ? "Pick a campaign…" : "No campaigns found"}
                  searchable
                />
                <p className="text-[10px] leading-snug text-neutral-600">Your new ad set{audiences.length === 1 ? "" : "s"} drop into this campaign. Budget stays as the campaign’s.</p>
              </>
            )}
            {structuredActive ? (
              /* One ad set per folder: shared targeting for all, buckets differ only by name + creatives. */
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="mono-label">Folders → ad sets · {includedBuckets.length}</span>
                  <button onClick={() => setStructured(false)} className="text-[11px] font-medium text-neutral-400 hover:text-neutral-100" title="Switch to manually-defined audiences">
                    Manual
                  </button>
                </div>
                {/* Shared targeting + destination applied to every folder's ad set. */}
                <button
                  onClick={() => audiences[0] && setEditingAudId(audiences[0].id)}
                  className="mb-2 flex w-full items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-left shadow-xs transition-colors hover:border-neutral-700"
                >
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", firstAudience.destination === "site" ? "bg-sky-400" : "bg-emerald-400")} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-neutral-200">Targeting &amp; destination</span>
                    <span className="mt-0.5 block truncate text-[10px] text-neutral-600">
                      {audienceSummary(firstAudience)}
                      {firstAudience.destination === "site" ? " · Landing page" : " · Instant form"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] font-medium text-accent">Edit</span>
                </button>
                {/* Shared copy — the SAME primary text + headline on every ad in every folder. */}
                <div className="mb-2 space-y-1.5">
                  <textarea
                    value={structuredRows[0]?.primaryText?.[0] ?? ""}
                    onChange={(e) => setAllBucketCopy("primaryText", e.target.value)}
                    placeholder="Primary text — same on every ad"
                    rows={2}
                    className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                  <input
                    value={structuredRows[0]?.headline?.[0] ?? ""}
                    onChange={(e) => setAllBucketCopy("headline", e.target.value)}
                    placeholder="Headline — same on every ad"
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </div>
                {/* Bucket list — include/exclude + editable ad-set name + creative count. */}
                <div className="space-y-1">
                  {buckets.map((b) => {
                    const inc = !excludedBuckets.has(b.id);
                    return (
                      <div key={b.id} className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-xs", inc ? "border-neutral-800 bg-neutral-900" : "border-neutral-800/60 bg-neutral-950/40 opacity-60")}>
                        <input
                          type="checkbox"
                          checked={inc}
                          onChange={() => toggleBucket(b.id)}
                          title={inc ? "Included — uncheck to skip this folder" : "Excluded"}
                          className="h-3.5 w-3.5 shrink-0 rounded border-neutral-600 bg-surface-200 text-accent focus:ring-2 focus:ring-accent/30"
                        />
                        <input
                          value={b.name}
                          onChange={(e) => setBucketName(b.id, e.target.value)}
                          className="min-w-0 flex-1 bg-transparent text-xs font-medium text-neutral-200 focus:outline-none"
                          title="Ad set name"
                        />
                        <span className="shrink-0 tabular-nums text-[10px] text-neutral-600">{b.count}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-neutral-600">One ad set per folder — same copy, targeting &amp; destination on all. Uncheck a folder to skip it.</p>
              </div>
            ) : (
              /* Audiences — one PAUSED ad set each. Assign ads to them via the per-row column. */
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="mono-label">Audiences · {audiences.length}</span>
                  <div className="flex items-center gap-2">
                    {hasBuckets && (
                      <button onClick={() => setStructured(true)} className="text-[11px] font-medium text-neutral-400 hover:text-neutral-100" title="One ad set per imported folder">
                        Per folder
                      </button>
                    )}
                    <button onClick={addAudience} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-600">
                      <PlusIcon className="h-3 w-3" /> Add audience
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {audiences.map((s) => (
                    <div key={s.id} className="rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 shadow-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.audience.destination === "site" ? "bg-sky-400" : "bg-emerald-400")} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">{s.name}</span>
                        <button onClick={() => setEditingAudId(s.id)} className="shrink-0 text-[11px] font-medium text-accent hover:text-accent-600">Edit</button>
                        <button onClick={() => duplicateAudience(s.id)} aria-label="Duplicate audience" className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200">
                          <CopyIcon className="h-3 w-3" />
                        </button>
                        {audiences.length > 1 && (
                          <button onClick={() => deleteAudience(s.id)} aria-label="Delete audience" className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-rose-400">
                            <TrashIcon className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[10px] text-neutral-600">
                        {audienceSummary(s.audience)}
                        {s.audience.destination === "site" ? " · Landing page" : ""}
                      </p>
                    </div>
                  ))}
                </div>
                {audiences.length > 1 && (
                  <p className="mt-1.5 text-[10px] leading-snug text-neutral-600">Pick which audiences each ad runs in (right column). New ads run in all.</p>
                )}
              </div>
            )}
            {/* Plain-language confirmation of exactly where this launch lands. */}
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-[11px] leading-relaxed shadow-xs">
              <div className="flex items-start gap-1.5 text-neutral-300">
                <span className="text-neutral-500">→</span>
                <span>
                  {campaignMode === "new" ? (
                    <>New campaign <span className="font-medium text-neutral-100">“{newCampaignName.trim() || "name it above"}”</span></>
                  ) : (
                    <>Into campaign <span className="font-medium text-neutral-100">“{data.adSetTree.find((c) => c.campaignId === campaignId)?.campaignName || "pick one above"}”</span></>
                  )}
                </span>
              </div>
              <div className="mt-0.5 pl-4 tabular-nums text-[10px] text-neutral-500">
                {(structuredActive ? includedBuckets.length : audiences.length)} new ad set{(structuredActive ? includedBuckets.length : audiences.length) === 1 ? "" : "s"} · {launchCount} ad{launchCount === 1 ? "" : "s"} · all paused
              </div>
            </div>
          </div>
        )}
      </aside>
      </div>

      {plan && (
        <LaunchPlanModal
          variationAds={plan.variationAds}
          withVars={plan.withVars}
          stripped={plan.stripped}
          onKeepVariations={() => { setPlan(null); void launch({ force: true }); }}
          onFirstCopyOnly={() => { setPlan(null); void launch({ force: true, strip: true }); }}
          onClose={() => setPlan(null)}
        />
      )}
      {showCols && <ColumnPicker visible={visible} onChange={setVisible} onClose={() => setShowCols(false)} />}
      {bulkField && (
        <BulkEditModal field={bulkField} count={selected.size} format={rows[0]?.format ?? "single"} data={{ ...data, leadForms }} onApply={applyBulk} onClose={() => setBulkField(null)} />
      )}
      {showConvert && <ConvertModal rows={rows} onConvert={convertAll} onClose={() => setShowConvert(false)} />}
      {showAddAds && <AddAdsModal onAdd={onAddAds} onClose={() => setShowAddAds(false)} />}
      {editingAudId && (() => {
        const s = audiences.find((x) => x.id === editingAudId);
        if (!s) return null;
        return (
          <LaunchSettingsModal
            audience={s.audience}
            setAudience={(a) => setAudienceFor(s.id, a)}
            defaultWebsiteUrl={defaultWebsiteUrl}
            // Structured mode: ad-set names come from the folders, so hide the single-name field (shared targeting only).
            name={structuredActive ? undefined : s.name}
            setName={structuredActive ? undefined : (n) => setAudienceNameFor(s.id, n)}
            presetId={s.presetId}
            setPresetId={(id) => setAudiencePresetFor(s.id, id)}
            presets={presets}
            setPresets={setPresets}
            onClose={() => setEditingAudId(null)}
          />
        );
      })()}
      {formBuilderRow && (
        <LeadFormBuilderModal
          defaultName={rows.find((r) => r.id === formBuilderRow)?.name ? `${rows.find((r) => r.id === formBuilderRow)!.name} form` : ""}
          editId={formBuilderEditId}
          pageName={data.pages[0]?.name ?? ""}
          onDone={onFormDone}
          onDeleted={(id) => {
            setLeadForms((fs) => fs.filter((f) => f.id !== id));
            setRows((rs) => rs.map((r) => (r.leadFormId === id ? { ...r, leadFormId: null } : r)));
          }}
          onClose={closeFormBuilder}
        />
      )}
      {previewRow && (() => {
        const r = rows.find((x) => x.id === previewRow);
        return r ? <PreviewModal row={r} creatives={creatives} onClose={() => setPreviewRow(null)} /> : null;
      })()}
      {cropRow && (() => {
        const r = rows.find((x) => x.id === cropRow);
        const c = r ? byId.get(r.creativeIds[0]) : null;
        if (!r || !c) return null;
        return (
          <CropModal
            imageUrl={c.previewUrl}
            crop={r.feedCrop}
            onSave={(crop) => { patch(r.id, { feedCrop: crop }); setCropRow(null); }}
            onClose={() => setCropRow(null)}
          />
        );
      })()}
      {leaving && (
        <LeavePrompt
          onContinue={() => { setLeaving(false); setPendingHref(null); }}
          onSaveDraft={() => {
            const next = pendingHref;
            setPendingHref(null);
            setLeaving(false);
            saveDraft(next);
          }}
          onDiscard={() => {
            const next = pendingHref;
            setPendingHref(null);
            setLeaving(false);
            if (next) router.push(next);
            else onExit();
          }}
        />
      )}
    </div>
  );
}
