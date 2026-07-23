"use client";

import { useEffect, useRef, useState } from "react";
import { SectionLabel } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { createClient } from "@/lib/supabase/client";
import { ImportZone } from "./ImportZone";
import { ChooseFormatModal } from "./ChooseFormatModal";
import { GroupingModal } from "./GroupingModal";
import { CarouselModal } from "./CarouselModal";
import { LaunchHistory } from "./LaunchHistory";
import { DuplicateModal } from "./DuplicateModal";
import { newGroupId } from "./GroupingShared";
import { AdSetup, type DraftContext } from "./adsetup/AdSetup";
import { FramingReview } from "./adsetup/FramingReview";
import { AdSetBoard } from "./AdSetBoard";
import { FactoryIcon, ArrowRightIcon, CopyIcon } from "./icons";
import type { UploadedCreative, AdFormat, GroupableFormat, Group, AdRow, AdSetupData, LaunchRow, ExistingAd, Option, BoardSeed } from "./types";

type Step = "none" | "format" | "grouping";

/** Downscale an image File to a small JPEG data URL (enough to read the text, cheap to send for naming). */
function imageToSmallBase64(file: File, maxDim = 1024): Promise<{ base64: string; mediaType: string } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight) || 1);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ base64: dataUrl.replace(/^data:image\/jpeg;base64,/, ""), mediaType: "image/jpeg" });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/** Run async work over items with a small concurrency cap. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** Rebuild a File from a data URL (used when loading an existing ad's image into the editor). */
function dataUrlToFile(dataUrl: string, name: string): File {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);/)?.[1] || "image/jpeg";
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

export function AdLauncher({ launches, data, existingAds }: { launches: LaunchRow[]; data: AdSetupData; existingAds: ExistingAd[] }) {
  const [creatives, setCreatives] = useState<UploadedCreative[]>([]);
  const [step, setStep] = useState<Step>("none");
  const [groupFormat, setGroupFormat] = useState<GroupableFormat | null>(null);
  const [groups, setGroups] = useState<Group[]>([]); // multi_ratio / flexible
  const [carousels, setCarousels] = useState<Group[]>([]); // carousel
  // Ad Setup table state.
  const [inSetup, setInSetup] = useState(false);
  const [inBoard, setInBoard] = useState(false); // ad-set board (drag ads into ad sets, before the sheet)
  const [boardSeed, setBoardSeed] = useState<BoardSeed | null>(null); // handoff from the board → the sheet
  const [framing, setFraming] = useState(false); // framing-review step (single-image launches, before the sheet)
  const [adRows, setAdRows] = useState<AdRow[]>([]);
  const [launchFormat, setLaunchFormat] = useState<AdFormat>("single");
  const [resumeCtx, setResumeCtx] = useState<DraftContext | null>(null); // set when reopening a saved draft
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [extraLeadForms, setExtraLeadForms] = useState<Option[]>([]); // "kept" Meta forms from duplicated ads
  const [namingIds, setNamingIds] = useState<Set<string>>(new Set()); // rows whose name is being auto-generated

  const creativesRef = useRef(creatives);
  creativesRef.current = creatives;
  useEffect(() => () => creativesRef.current.forEach((c) => URL.revokeObjectURL(c.previewUrl)), []);

  function addCreatives(added: UploadedCreative[]) {
    setCreatives((prev) => [...prev, ...added]);
    setStep("format");
  }

  function reset() {
    setStep("none");
    setGroupFormat(null);
    setGroups([]);
    setCarousels([]);
    setInSetup(false);
    setInBoard(false);
    setBoardSeed(null);
    setFraming(false);
    setAdRows([]);
    setResumeCtx(null);
    setExtraLeadForms([]);
    creatives.forEach((c) => URL.revokeObjectURL(c.previewUrl));
    setCreatives([]);
  }

  const cleanName = (n: string) => n.replace(/\.[^.]+$/, "");

  function makeRow(format: AdFormat, creativeIds: string[], displayName: string, bucket: string | null = null, bucketName: string | null = null): AdRow {
    return {
      id: newGroupId(),
      format,
      status: "PAUSED", // everything starts paused (our safety rule); user can flip per ad
      name: displayName,
      creativeIds,
      primaryText: [""],
      headline: [""],
      description: [""],
      link: "",
      whatsapp: null,
      cta: "LEARN_MORE",
      facebookPageId: data.pages[0]?.id ?? null,
      instagramId: null,
      enhancements: false, // default OFF for every new ad in the sheet (user preference)
      utm: "",
      leadFormId: null,
      adSetIds: [],
      audienceIds: [], // Launch New: empty = all audiences
      bucket, // folder-import: which leaf folder → becomes the ad set in "one ad set per folder" mode
      bucketName,
    };
  }

  function buildRows(format: AdFormat): AdRow[] {
    const bucketFor = (ids: string[]) => creatives.find((c) => c.id === ids[0]) ?? null;
    const nameFor = (ids: string[]) => {
      const first = bucketFor(ids);
      return first ? cleanName(first.name) : "New ad";
    };
    if (format === "single") return creatives.map((c) => makeRow(format, [c.id], cleanName(c.name), c.bucket ?? null, c.bucketName ?? null));
    const groupsList = format === "carousel" ? carousels : groups;
    const groupedIds = new Set(groupsList.flatMap((g) => g.creativeIds));
    const ungrouped = creatives.filter((c) => !groupedIds.has(c.id));
    return [
      ...groupsList.map((g) => { const b = bucketFor(g.creativeIds); return makeRow(format, g.creativeIds, nameFor(g.creativeIds), b?.bucket ?? null, b?.bucketName ?? null); }),
      // A lone (ungrouped) creative can't be a valid carousel (needs ≥2 cards) — never emit a 1-card carousel;
      // the carousel modal blocks Continue until all are grouped, this is defense-in-depth (N-launcher-secondary-0).
      ...(format === "carousel" ? [] : ungrouped.map((c) => makeRow(format, [c.id], cleanName(c.name), c.bucket ?? null, c.bucketName ?? null))),
    ];
  }

  // Auto-generate a short ad name from each image creative's text (a vision model reads the headline).
  // Best-effort + non-blocking: the table opens immediately with the filename, names fill in as they return,
  // and we never clobber a name the user has already edited.
  async function autoName(rows: AdRow[], pool: UploadedCreative[]) {
    const byId = new Map(pool.map((c) => [c.id, c]));
    const targets = rows.filter((r) => byId.get(r.creativeIds[0])?.kind === "image");
    if (!targets.length) return;
    setNamingIds((prev) => { const n = new Set(prev); targets.forEach((r) => n.add(r.id)); return n; });
    const named: { id: string; name: string }[] = [];
    await runPool(targets, 4, async (row) => {
      const c = byId.get(row.creativeIds[0])!;
      const original = row.name;
      try {
        const small = await imageToSmallBase64(c.file);
        if (small) {
          const res = await fetch("/api/ads/name-from-image", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ imageBase64: small.base64, mediaType: small.mediaType }),
          });
          const j = await res.json().catch(() => ({}));
          if (j?.name) {
            named.push({ id: row.id, name: j.name });
            setAdRows((prev) => prev.map((r) => (r.id === row.id && r.name === original ? { ...r, name: j.name } : r)));
          }
        }
      } catch {
        // keep the filename
      } finally {
        setNamingIds((prev) => { const n = new Set(prev); n.delete(row.id); return n; });
      }
    });
    // Same copy on two creatives → the same generated name. Number the duplicates ("Headline",
    // "Headline 2", …) so no two rows launch with identical names.
    // Only rewrites rows still holding their auto-name (never clobbers a name the user edited).
    const byName = new Map<string, { id: string; name: string }[]>();
    for (const r of named) { const arr = byName.get(r.name); if (arr) arr.push(r); else byName.set(r.name, [r]); }
    const renamed = new Map<string, { from: string; to: string }>();
    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      group.forEach((g, i) => {
        if (i > 0) renamed.set(g.id, { from: name, to: `${name} ${i + 1}` });
      });
    }
    if (renamed.size) {
      setAdRows((prev) => prev.map((r) => { const u = renamed.get(r.id); return u && r.name === u.from ? { ...r, name: u.to } : r; }));
    }
  }

  // Fresh imports go through the ad-set board (drag ads into ad sets) before the review sheet.
  function goToBoard(format: AdFormat) {
    const rows = buildRows(format);
    setLaunchFormat(format);
    setAdRows(rows);
    setResumeCtx(null); // a fresh launch, not a reopened draft
    setBoardSeed(null);
    setStep("none");
    setFraming(false);
    setInBoard(true);
    void autoName(rows, creatives);
  }

  // Single-image launches get a framing-review step first (check Stories vs Feed crops). If there are no
  // image creatives to frame, skip straight to the board.
  function goToFraming(format: AdFormat) {
    const rows = buildRows(format);
    const hasImage = rows.some((r) => creatives.find((c) => c.id === r.creativeIds[0])?.kind === "image");
    if (!hasImage) { goToBoard(format); return; }
    setLaunchFormat(format);
    setAdRows(rows);
    setResumeCtx(null);
    setStep("none");
    setFraming(true);
  }

  // Framing accepted → into the ad-set board, naming the (crop-carrying) rows on the way in.
  function enterBoardFromFraming() {
    setFraming(false);
    setBoardSeed(null);
    setInBoard(true);
    void autoName(adRows, creatives);
  }

  // Board finished → into the review sheet, carrying the ad-set config as a seed (rows already assigned).
  function enterSetupFromBoard(seed: BoardSeed) {
    setBoardSeed(seed);
    setInBoard(false);
    setInSetup(true);
  }

  // "+ Add Ads" in the table: register new creatives and append a row per creative (in the launch's format).
  function addAds(newCreatives: UploadedCreative[]) {
    setCreatives((prev) => [...prev, ...newCreatives]);
    // Match the table's CURRENT format (Convert-to-Multi-Ratio mutates rows without touching launchFormat),
    // so appended rows never create a mixed-format table that the launch would reject.
    const fmt = adRows[0]?.format ?? launchFormat;
    const newRows = newCreatives.map((c) => makeRow(fmt, [c.id], cleanName(c.name), c.bucket ?? null, c.bucketName ?? null));
    setAdRows((prev) => [...prev, ...newRows]);
    void autoName(newRows, newCreatives);
  }

  // Duplicate existing ads → open them in the Ad Setup grid (pre-filled), so the user can tweak a
  // thing or two and then launch. Creates nothing on Meta until they hit Launch (all paused).
  async function openDuplicatesInEditor(ids: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch("/api/ads/duplicate-load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(j.ads) || !j.ads.length) return { ok: false, error: j.error || "Couldn't load those ads" };

      const loadedCreatives: UploadedCreative[] = [];
      const loadedRows: AdRow[] = [];
      const forms = new Map<string, string>(); // kept Meta forms → label
      for (const a of j.ads as any[]) {
        const file = dataUrlToFile(a.imageDataUrl, `${(a.name || "creative").replace(/[^\w.-]+/g, "_")}.jpg`);
        const c: UploadedCreative = { id: newGroupId(), file, name: a.name, kind: "image", previewUrl: URL.createObjectURL(file), size: file.size };
        loadedCreatives.push(c);
        const row = makeRow("single", [c.id], a.name);
        row.primaryText = a.primaryText?.length ? a.primaryText : [""];
        row.headline = a.headline?.length ? a.headline : [""];
        row.description = a.description?.length ? a.description : [""];
        row.link = a.link || "";
        row.cta = a.cta || "LEARN_MORE";
        row.leadFormId = a.leadFormId || null;
        row.adSetIds = a.adsetId ? [a.adsetId] : []; // pre-select the source ad set (Existing mode)
        loadedRows.push(row);
        if (a.leadFormId) forms.set(a.leadFormId, a.leadFormName ? `${a.leadFormName} (kept)` : "Original lead form (kept)");
      }

      creatives.forEach((cc) => URL.revokeObjectURL(cc.previewUrl));
      setExtraLeadForms(Array.from(forms, ([id, name]) => ({ id, name })));
      setCreatives(loadedCreatives);
      setAdRows(loadedRows);
      setLaunchFormat("single");
      setResumeCtx(null);
      setShowDuplicate(false);
      // Duplicates go through the ad-set board too, so they can be split across new ad sets (or dropped
      // back into their source ad set via Existing mode — their adSetIds are already pre-selected).
      setBoardSeed(null);
      setInBoard(true);
      if (Array.isArray(j.skipped) && j.skipped.length) {
        toast(`${j.ads.length} loaded · ${j.skipped.length} skipped (videos/unsupported can't be edited yet)`);
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't load those ads" };
    }
  }

  // "New creative" duplicate → open the editor with a BRAND-NEW image but the source ad's setup
  // (its ad set pre-selected + kept lead form + link), pre-filled with the new copy. Full destination
  // control happens in the grid (Existing / Launch New with audiences, landing page, CBO/ABO).
  async function openRecomposeInEditor(p: { sourceId: string; name: string; message: string; headline: string; cta: string; imageDataUrl: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      // setupOnly: we only need the source's ad set + lead form + link (the image is the new one below).
      const res = await fetch("/api/ads/duplicate-load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [p.sourceId], setupOnly: true }) });
      const j = await res.json().catch(() => ({}));
      const src = Array.isArray(j.ads) ? j.ads[0] : null;
      if (!res.ok || !src) return { ok: false, error: j.error || "Couldn't load that ad" };
      const file = dataUrlToFile(p.imageDataUrl, `${(p.name || "creative").replace(/[^\w.-]+/g, "_")}.jpg`);
      const c: UploadedCreative = { id: newGroupId(), file, name: p.name || src.name, kind: "image", previewUrl: URL.createObjectURL(file), size: file.size };
      const row = makeRow("single", [c.id], p.name || src.name);
      row.primaryText = [p.message || ""];
      row.headline = [p.headline || ""];
      row.link = src.link || "";
      row.cta = p.cta || "LEARN_MORE";
      row.leadFormId = src.leadFormId || null; // kept from the source ("meta:<id>")
      row.adSetIds = src.adsetId ? [src.adsetId] : []; // source ad set pre-selected (Existing mode)
      creatives.forEach((cc) => URL.revokeObjectURL(cc.previewUrl));
      setExtraLeadForms(src.leadFormId ? [{ id: src.leadFormId, name: src.leadFormName ? `${src.leadFormName} (kept)` : "Original lead form (kept)" }] : []);
      setCreatives([c]);
      setAdRows([row]);
      setLaunchFormat("single");
      setResumeCtx(null);
      setShowDuplicate(false);
      setBoardSeed(null);
      setInBoard(true);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't open the editor" };
    }
  }

  const [resuming, setResuming] = useState(false);
  // Reopen a saved draft: pull its state, re-download the creatives from Storage, repopulate the table.
  async function resumeDraft(id: string) {
    if (resuming || inSetup) return;
    setResuming(true);
    try {
      const res = await fetch(`/api/launches/${id}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.draftState?.creatives) {
        toast("Couldn't open that draft", "error");
        return;
      }
      const supabase = createClient();
      const rebuilt: UploadedCreative[] = [];
      for (const m of j.draftState.creatives as { id: string; name: string; kind: "image" | "video"; path: string; type: string; size: number }[]) {
        const { data: blob } = await supabase.storage.from("launch-media").download(m.path);
        if (!blob) continue;
        const file = new File([blob], m.name, { type: m.type || blob.type });
        rebuilt.push({ id: m.id, file, name: m.name, kind: m.kind, previewUrl: URL.createObjectURL(file), size: m.size });
      }
      if (!rebuilt.length) {
        toast("This draft's media is no longer available", "error");
        return;
      }
      creatives.forEach((c) => URL.revokeObjectURL(c.previewUrl));
      setCreatives(rebuilt);
      // Normalize older drafts whose rows predate per-row audience assignment.
      setAdRows((j.draftState.rows ?? []).map((r: AdRow) => ({ ...r, audienceIds: r.audienceIds ?? [] })));
      setLaunchFormat(j.draftState.launchFormat ?? "single");
      setResumeCtx({
        id,
        adSetMode: j.draftState.adSetMode === "new" ? "new" : "existing",
        campaignName: j.draftState.newCampaignName ?? "",
        budget: j.draftState.newBudget ?? "",
        draftKey: j.draftState.creatives?.[0]?.path?.split("/")[1], // "drafts/<key>/..." — reuse on re-save
        audiences: j.draftState.audiences, // multi-audience drafts
        audience: j.draftState.audience, // legacy single-audience drafts (back-compat)
        presetId: j.draftState.presetId ?? null,
        campaignMode: j.draftState.campaignMode ?? "new",
        campaignId: j.draftState.campaignId ?? null,
        adSetName: j.draftState.adSetName ?? "",
        budgetMode: j.draftState.budgetMode ?? "cbo",
        structured: j.draftState.structured,
        bucketNames: j.draftState.bucketNames,
        excludedBuckets: j.draftState.excludedBuckets,
      });
      setInSetup(true);
    } catch {
      toast("Couldn't open that draft", "error");
    } finally {
      setResuming(false);
    }
  }

  function chooseFormat(format: AdFormat) {
    if (format === "single") {
      goToFraming("single");
      return;
    }
    if (format !== groupFormat) {
      setGroups([]);
      setCarousels([]);
      setGroupFormat(format);
    }
    setStep("grouping");
  }

  return (
    <div className="mt-8 space-y-10">
      <section className="space-y-3">
        <SectionLabel>Import creatives</SectionLabel>
        <ImportZone onAdd={addCreatives} />

        {/* Duplicate existing ads — both flavors (exact copy / new creative) live in the DuplicateModal. */}
        <button
          onClick={() => setShowDuplicate(true)}
          className="group flex w-full items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-left shadow-xs transition-colors hover:border-neutral-700 hover:bg-surface-200/60"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent ring-1 ring-inset ring-accent/25">
            <CopyIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-neutral-100">Duplicate existing ads</div>
            <div className="mt-0.5 text-xs text-neutral-500">Clone current ads as-is, or reuse their setup with a fresh creative</div>
          </div>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-700 bg-neutral-700/30 text-neutral-400 transition-colors group-hover:border-neutral-600 group-hover:text-neutral-100" aria-hidden="true">
            <ArrowRightIcon className="h-4 w-4" />
          </span>
        </button>

        {/* "Need new creatives?" — kept to match the reference design; intentionally not wired to anything yet. */}
        <div className="flex items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent ring-1 ring-inset ring-accent/25">
            <FactoryIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-neutral-100">Need new creatives?</div>
            <div className="mt-0.5 text-xs text-neutral-500">Design ads with AI in the Ad Factory</div>
          </div>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-700 bg-neutral-700/30 text-neutral-400" aria-hidden="true">{/* dropped dead group-hover: this card has no group ancestor + isn't wired (C61) */}
            <ArrowRightIcon className="h-4 w-4" />
          </span>
        </div>
      </section>

      <LaunchHistory launches={launches} onResume={resumeDraft} resuming={resuming} />

      {step === "format" && <ChooseFormatModal creatives={creatives} onClose={reset} onAddMore={addCreatives} onContinue={chooseFormat} />}
      {step === "grouping" && groupFormat === "carousel" && (
        <CarouselModal
          creatives={creatives}
          carousels={carousels}
          setCarousels={setCarousels}
          onBack={() => setStep("format")}
          onClose={reset}
          onContinue={() => goToBoard("carousel")}
        />
      )}
      {step === "grouping" && (groupFormat === "multi_ratio" || groupFormat === "flexible") && (
        <GroupingModal
          creatives={creatives}
          mode={groupFormat}
          groups={groups}
          setGroups={setGroups}
          onBack={() => setStep("format")}
          onClose={reset}
          onContinue={() => goToBoard(groupFormat)}
        />
      )}

      {framing && (
        <FramingReview
          rows={adRows}
          setRows={setAdRows}
          creatives={creatives}
          onBack={reset}
          onContinue={enterBoardFromFraming}
        />
      )}

      {inBoard && (
        <AdSetBoard
          rows={adRows}
          setRows={setAdRows}
          creatives={creatives}
          data={extraLeadForms.length ? { ...data, leadForms: [...extraLeadForms, ...data.leadForms] } : data}
          onBack={() => { setInBoard(false); setStep("format"); }}
          onContinue={enterSetupFromBoard}
        />
      )}

      {inSetup && (
        <AdSetup
          rows={adRows}
          setRows={setAdRows}
          creatives={creatives}
          data={extraLeadForms.length ? { ...data, leadForms: [...extraLeadForms, ...data.leadForms] } : data}
          onExit={reset}
          onAddAds={addAds}
          draft={resumeCtx ?? undefined}
          seed={boardSeed ?? undefined}
          namingIds={namingIds}
        />
      )}

      {showDuplicate && (
        <DuplicateModal
          ads={existingAds}
          data={data}
          onOpenInEditor={openDuplicatesInEditor}
          onOpenRecomposeInEditor={openRecomposeInEditor}
          onClose={() => setShowDuplicate(false)}
        />
      )}
    </div>
  );
}
