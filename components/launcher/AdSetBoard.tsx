"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, XIcon, TrashIcon, ChevronDownIcon, SearchIcon, VideoIcon } from "./icons";
import { Popover, CheckBox, Select } from "./adsetup/Select";
import { LaunchSettingsModal } from "./adsetup/LaunchSettingsModal";
import { LeadFormBuilderModal } from "./adsetup/LeadFormBuilderModal";
import { LeadFormPicker } from "./adsetup/LeadFormPicker";
import { DEFAULT_AUDIENCE, audienceFromPreset, audienceSummary, adSetNameFor, campaignNameFor, makeAudienceSet } from "./audience";
import { useBodyScrollLock } from "./useBodyScrollLock";
import type { AdRow, UploadedCreative, AdSetupData, LaunchAudience, AudienceSet, Preset, AdSetOption, BoardSeed } from "./types";

/**
 * The Ad-Set Board — a drag-and-drop step BEFORE the review table.
 * Columns = ad sets (New: a targeting config → its own PAUSED ad set; Existing: picked from the account).
 * Cards = the ads. Drag a card onto a column to put that ad in that ad set. One launch is all-New OR
 * all-Existing (no mixing). Assignment is written straight onto each row (audienceIds / adSetIds), so the
 * table opens with ad sets already sorted; `onContinue` hands the launch-wide config to AdSetup as a seed.
 */
export function AdSetBoard({
  rows,
  setRows,
  creatives,
  data,
  onBack,
  onContinue,
}: {
  rows: AdRow[];
  setRows: React.Dispatch<React.SetStateAction<AdRow[]>>;
  creatives: UploadedCreative[];
  data: AdSetupData;
  onBack: () => void;
  onContinue: (seed: BoardSeed) => void;
}) {
  useBodyScrollLock(); // pin the page behind this full-screen overlay
  const byId = useMemo(() => new Map(creatives.map((c) => [c.id, c])), [creatives]);
  const hasBuckets = rows.some((r) => !!r.bucket);
  // Flexible & Multi-Ratio each need their own fresh ad set — they can't drop into an existing one.
  const formatNeedsNew = rows.some((r) => r.format !== "single" && r.format !== "carousel");

  const [mode, setMode] = useState<"new" | "existing">("new");

  // Per-column targeting (New mode) reuses the launcher's audience model + settings modal.
  const [presets, setPresets] = useState<Preset[]>(data.presets);
  const defaultWebsiteUrl = data.defaultWebsiteUrl || "";
  const initialPreset = data.presets[0] ?? null;
  const withDefaultUrl = (a: LaunchAudience): LaunchAudience => ({ ...a, landingUrl: (a.landingUrl || "").trim() || defaultWebsiteUrl });
  const baseAudience = (): LaunchAudience => withDefaultUrl(initialPreset ? audienceFromPreset(initialPreset) : DEFAULT_AUDIENCE);

  // New-mode columns: one AudienceSet each. Seed one column per imported folder (id = the bucket id, so
  // bucketed ads auto-sort into their column), else a single default column.
  const [columns, setColumns] = useState<AudienceSet[]>(() => {
    if (hasBuckets) {
      const seen = new Map<string, string>();
      for (const r of rows) if (r.bucket && !seen.has(r.bucket)) seen.set(r.bucket, r.bucketName || r.bucket);
      return [...seen.entries()].map(([id, name]) => ({ ...makeAudienceSet(baseAudience(), initialPreset?.id ?? null, name), id }));
    }
    // No explicit name → the name is derived from the settings (adSetNameFor) and keeps tracking them
    // (nameEdited: false) until the user types their own.
    return [makeAudienceSet(baseAudience(), initialPreset?.id ?? null)];
  });
  const [editingColId, setEditingColId] = useState<string | null>(null);

  // Existing-mode columns: ad sets picked from the account tree.
  const [existingCols, setExistingCols] = useState<AdSetOption[]>([]);

  // Lead forms for instant-form ad sets — stateful so a form built here appears immediately. Chosen per column.
  const [leadForms, setLeadForms] = useState(data.leadForms);
  const [formBuilderColId, setFormBuilderColId] = useState<string | null>(null); // which column's form builder is open
  const [formBuilderEditId, setFormBuilderEditId] = useState<string | null>(null);

  // Campaign + budget config (New mode).
  const [campaignMode, setCampaignMode] = useState<"new" | "existing">("new");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState("");
  const [campaignNameEdited, setCampaignNameEdited] = useState(false);
  const [budget, setBudget] = useState("");
  const [budgetMode, setBudgetMode] = useState<"cbo" | "abo">("abo"); // ABO by default — a fixed budget per ad set

  const firstAud = columns[0]?.audience ?? DEFAULT_AUDIENCE;
  useEffect(() => {
    if (!campaignNameEdited) setCampaignName(campaignNameFor(firstAud));
  }, [firstAud, campaignNameEdited]);

  // On mount, pre-sort cards: bucketed ads → their folder's column; otherwise everything into column 1
  // (a simple launch is one ad set — the user only drags when splitting into more).
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    setRows((rs) => {
      if (hasBuckets) return rs.map((r) => (r.bucket && r.audienceIds.length === 0 ? { ...r, audienceIds: [r.bucket] } : r));
      const first = columns[0]?.id;
      if (!first) return rs;
      return rs.map((r) => (r.audienceIds.length === 0 ? { ...r, audienceIds: [first] } : r));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Column helpers (New mode) -----
  const updateColumn = (id: string, fn: (c: AudienceSet) => AudienceSet) => setColumns((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  const setColAudience = (id: string, a: LaunchAudience) => updateColumn(id, (c) => ({ ...c, audience: a, name: c.nameEdited ? c.name : adSetNameFor(a) }));
  const setColName = (id: string, n: string) => updateColumn(id, (c) => ({ ...c, name: n, nameEdited: true }));
  const setColPreset = (id: string, pid: string | null) => updateColumn(id, (c) => ({ ...c, presetId: pid }));
  function addColumn() {
    const base = columns[0]?.audience ? { ...columns[0].audience } : baseAudience();
    // No explicit name → auto-named from its settings and live-updating (nameEdited: false) until edited.
    const seed = makeAudienceSet(base, columns[0]?.presetId ?? initialPreset?.id ?? null);
    setColumns((cs) => [...cs, seed]);
  }
  function removeColumn(id: string) {
    if (columns.length <= 1) {
      toast("Keep at least one ad set");
      return;
    }
    setColumns((cs) => cs.filter((c) => c.id !== id));
    setRows((rs) => rs.map((r) => (r.audienceIds.includes(id) ? { ...r, audienceIds: [] } : r)));
  }

  // ----- Column helpers (Existing mode) -----
  function addExisting(opt: AdSetOption) {
    setExistingCols((cs) => (cs.some((c) => c.id === opt.id) ? cs : [...cs, opt]));
  }
  function removeExisting(id: string) {
    setExistingCols((cs) => cs.filter((c) => c.id !== id));
    setRows((rs) => rs.map((r) => (r.adSetIds.includes(id) ? { ...r, adSetIds: [] } : r)));
  }

  // ----- Assignment (which ad set each card is in) -----
  const colIds = useMemo(
    () => new Set(mode === "new" ? columns.map((c) => c.id) : existingCols.map((c) => c.id)),
    [mode, columns, existingCols]
  );
  const assignedColId = (r: AdRow): string | null => {
    const id = mode === "new" ? r.audienceIds[0] : r.adSetIds[0];
    return id && colIds.has(id) ? id : null; // an id pointing at a removed column reads as unassigned
  };
  const cardsIn = (colId: string | null) => rows.filter((r) => assignedColId(r) === colId);
  // The lead form shared by a column's ads (null if none / mixed). New-mode instant-form ad sets only.
  const columnFormId = (colId: string): string | null => {
    const inCol = cardsIn(colId);
    if (!inCol.length) return null;
    const id = inCol[0].leadFormId;
    return inCol.every((r) => r.leadFormId === id) ? id : null;
  };
  // A form column's current form so a card dropped in inherits it; undefined = leave the row's form untouched.
  const formForColumn = (colId: string): string | null | undefined => {
    if (mode !== "new") return undefined;
    const col = columns.find((c) => c.id === colId);
    return col && col.audience.destination === "form" ? columnFormId(colId) : undefined;
  };
  function assign(rowId: string, colId: string | null) {
    const form = colId ? formForColumn(colId) : undefined;
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== rowId) return r;
        if (mode === "new") return { ...r, audienceIds: colId ? [colId] : [], ...(form !== undefined ? { leadFormId: form } : {}) };
        return { ...r, adSetIds: colId ? [colId] : [] };
      })
    );
  }
  function moveAllHere(colId: string) {
    const ids = new Set(cardsIn(null).map((r) => r.id));
    if (!ids.size) return;
    const form = formForColumn(colId);
    setRows((rs) =>
      rs.map((r) =>
        ids.has(r.id)
          ? mode === "new"
            ? { ...r, audienceIds: [colId], ...(form !== undefined ? { leadFormId: form } : {}) }
            : { ...r, adSetIds: [colId] }
          : r
      )
    );
  }
  function deleteRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  // Apply a lead form to every ad in a column (also the target of a builder's new/edit/use-once result).
  function setColumnForm(colId: string, formId: string | null) {
    const ids = new Set(cardsIn(colId).map((r) => r.id));
    setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, leadFormId: formId } : r)));
  }
  function onFormDone(form: { id: string; name: string }) {
    setLeadForms((fs) => [form, ...fs.filter((f) => f.id !== form.id)]);
    if (formBuilderColId) setColumnForm(formBuilderColId, form.id);
    setFormBuilderColId(null);
    setFormBuilderEditId(null);
  }

  // ----- Drag & drop (native HTML5, same pattern as CarouselModal) -----
  const dragId = useRef<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null); // column id, or "__unassigned__"
  const UNASSIGNED = "__unassigned__";
  const dropHandlers = (key: string, colId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overCol !== key) setOverCol(key);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setOverCol((o) => (o === key ? null : o));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragId.current) assign(dragId.current, colId);
      dragId.current = null;
      setOverCol(null);
    },
  });

  const columnList: { id: string; name: string }[] =
    mode === "new" ? columns.map((c) => ({ id: c.id, name: c.name })) : existingCols.map((c) => ({ id: c.id, name: c.name }));
  const unassigned = cardsIn(null);

  function continueToTable() {
    if (mode === "new") {
      const used = columns.filter((c) => cardsIn(c.id).length > 0); // drop empty ad sets
      if (used.length === 0) {
        toast("Put at least one ad in an ad set");
        return;
      }
      if (campaignMode === "new") {
        if (!campaignName.trim()) {
          toast("Name the campaign");
          return;
        }
        if (!(Number(budget) >= 1)) {
          toast("Set a daily budget of at least €1");
          return;
        }
      } else if (!campaignId) {
        toast("Pick a campaign for the new ad sets");
        return;
      }
      for (const c of used) {
        if (!c.audience.facebook && !c.audience.instagram) {
          toast(`Turn on Facebook or Instagram for "${c.name}"`);
          setEditingColId(c.id);
          return;
        }
        if (c.audience.destination === "site" && !c.audience.landingUrl.trim()) {
          toast(`Add a landing-page URL for "${c.name}"`);
          setEditingColId(c.id);
          return;
        }
        if (c.audience.destination === "form" && !columnFormId(c.id)) {
          toast(`Pick a lead form for "${c.name}"`);
          return;
        }
      }
      if (unassigned.length > 0) {
        toast(`${unassigned.length} ad${unassigned.length === 1 ? "" : "s"} not in an ad set yet`);
        return;
      }
      onContinue({
        adSetMode: "new",
        leadForms, // carry forms built here so the table can resolve them
        audiences: used,
        campaignMode,
        campaignId: campaignMode === "existing" ? campaignId : null,
        campaignName: campaignName.trim(),
        budget,
        budgetMode: campaignMode === "existing" ? "cbo" : budgetMode,
      });
    } else {
      if (existingCols.length === 0) {
        toast("Add at least one existing ad set");
        return;
      }
      if (unassigned.length > 0) {
        toast(`${unassigned.length} ad${unassigned.length === 1 ? "" : "s"} not in an ad set yet`);
        return;
      }
      onContinue({ adSetMode: "existing", leadForms });
    }
  }

  const editingCol = editingColId ? columns.find((c) => c.id === editingColId) : null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-neutral-950 md:left-60">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 bg-panel px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            aria-label="Back"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 bg-transparent text-neutral-400 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <span className="truncate text-base font-semibold text-neutral-50">Organize ad sets</span>
          <span className="shrink-0 text-sm text-neutral-500">· {rows.length} ad{rows.length === 1 ? "" : "s"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* All-New OR all-Existing for one launch (no mixing). */}
          <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-xs">
            <button
              onClick={() => setMode("new")}
              className={cn("rounded px-3 py-1 font-medium transition-colors", mode === "new" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}
            >
              New ad sets
            </button>
            <button
              onClick={() => !formatNeedsNew && setMode("existing")}
              disabled={formatNeedsNew}
              title={formatNeedsNew ? "Flexible & Multi-Ratio need their own new ad set" : undefined}
              className={cn("rounded px-3 py-1 font-medium transition-colors", mode === "existing" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100", formatNeedsNew && "cursor-not-allowed opacity-40 hover:text-neutral-400")}
            >
              Existing ad sets
            </button>
          </div>
          <button
            onClick={continueToTable}
            className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-3 text-sm font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
          >
            Continue <ArrowRightIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Campaign + budget bar (New mode). */}
      {mode === "new" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-950/40 px-4 py-2.5">
          <span className="mono-label">Campaign</span>
          <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-[10px]">
            <button onClick={() => setCampaignMode("new")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", campaignMode === "new" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>New</button>
            <button onClick={() => setCampaignMode("existing")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", campaignMode === "existing" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>Existing</button>
          </div>
          {campaignMode === "new" ? (
            <>
              <input
                value={campaignName}
                onChange={(e) => { setCampaignName(e.target.value); setCampaignNameEdited(true); }}
                placeholder="Campaign name"
                className="h-[34px] w-56 rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-950/40 p-0.5 text-[10px]">
                <button onClick={() => setBudgetMode("cbo")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", budgetMode === "cbo" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>CBO</button>
                <button onClick={() => setBudgetMode("abo")} className={cn("rounded px-2 py-0.5 font-medium transition-colors", budgetMode === "abo" ? "bg-surface-200 text-neutral-100" : "text-neutral-400 hover:text-neutral-100")}>ABO</button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-neutral-500">€</span>
                <input
                  value={budget}
                  onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  placeholder={budgetMode === "cbo" ? "Daily budget" : "Budget / ad set"}
                  className="h-[34px] w-36 rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
              </div>
              <span className="text-[10px] text-neutral-600">{budgetMode === "cbo" ? "Meta splits the budget across ad sets" : "each ad set gets this budget"}</span>
            </>
          ) : (
            <div className="w-64">
              <Select
                value={campaignId}
                onChange={setCampaignId}
                options={data.adSetTree.map((c) => ({ id: c.campaignId, name: c.campaignName }))}
                placeholder={data.adSetTree.length ? "Pick a campaign…" : "No campaigns found"}
                searchable
              />
            </div>
          )}
        </div>
      )}

      {/* Board */}
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {/* Unassigned tray — only while there are orphaned ads (e.g. after removing an ad set). */}
        {unassigned.length > 0 && (
          <Lane
            title="Unassigned"
            count={unassigned.length}
            highlighted={overCol === UNASSIGNED}
            muted
            dropHandlers={dropHandlers(UNASSIGNED, null)}
          >
            {unassigned.map((r) => <Card key={r.id} row={r} creative={byId.get(r.creativeIds[0])} onDragStart={() => (dragId.current = r.id)} onDragEnd={() => (dragId.current = null)} onDelete={() => deleteRow(r.id)} />)}
          </Lane>
        )}

        {/* Ad-set columns */}
        {columnList.map((col) => {
          const cards = cardsIn(col.id);
          return (
            <Lane
              key={col.id}
              highlighted={overCol === col.id}
              dropHandlers={dropHandlers(col.id, col.id)}
              header={
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    {mode === "new" ? (
                      <input
                        value={col.name}
                        onChange={(e) => setColName(col.id, e.target.value)}
                        className="min-w-0 flex-1 rounded bg-transparent px-1 text-sm font-medium text-neutral-100 hover:bg-surface-200 focus:bg-surface-200 focus:outline-none"
                        title="Ad set name"
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-neutral-100" title={col.name}>{col.name}</span>
                    )}
                    <span className="shrink-0 tabular-nums rounded bg-neutral-800 px-1.5 text-[10px] text-neutral-400">{cards.length}</span>
                    <button
                      onClick={() => (mode === "new" ? removeColumn(col.id) : removeExisting(col.id))}
                      aria-label="Remove ad set"
                      className="shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:text-rose-400"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {mode === "new" && (() => {
                    const a = columns.find((c) => c.id === col.id)?.audience;
                    if (!a) return null;
                    return (
                      <button
                        onClick={() => setEditingColId(col.id)}
                        className="flex w-full items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-left transition-colors hover:border-neutral-700"
                      >
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.destination === "site" ? "bg-sky-400" : "bg-emerald-400")} />
                        <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-500">
                          {audienceSummary(a)}{a.destination === "site" ? " · Landing" : " · Form"}
                        </span>
                        <span className="shrink-0 text-[10px] font-medium text-accent">Edit</span>
                      </button>
                    );
                  })()}
                  {/* Instant-form ad sets pick their lead form here — applies to every ad in the column. */}
                  {mode === "new" && columns.find((c) => c.id === col.id)?.audience.destination === "form" && (
                    <LeadFormPicker
                      value={columnFormId(col.id)}
                      forms={leadForms}
                      onSelect={(id) => setColumnForm(col.id, id)}
                      onBuildNew={() => { setFormBuilderEditId(null); setFormBuilderColId(col.id); }}
                      onEdit={(id) => { setFormBuilderEditId(id); setFormBuilderColId(col.id); }}
                    />
                  )}
                  {unassigned.length > 0 && (
                    <button onClick={() => moveAllHere(col.id)} className="text-[11px] font-medium text-neutral-500 transition-colors hover:text-accent">
                      Move {unassigned.length} unassigned here
                    </button>
                  )}
                </div>
              }
            >
              {cards.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-neutral-600">Drag ads here</p>
              ) : (
                cards.map((r) => <Card key={r.id} row={r} creative={byId.get(r.creativeIds[0])} onDragStart={() => (dragId.current = r.id)} onDragEnd={() => (dragId.current = null)} onDelete={() => deleteRow(r.id)} />)
              )}
            </Lane>
          );
        })}

        {/* Add-column affordance */}
        {mode === "new" ? (
          <button
            onClick={addColumn}
            className="flex h-11 w-72 shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-dashed border-neutral-800 text-sm text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-200"
          >
            <PlusIcon className="h-4 w-4" /> Add ad set
          </button>
        ) : (
          <div className="w-72 shrink-0 self-start">
            <Popover
              width={300}
              trigger={({ toggle, ref }) => (
                <button
                  ref={ref}
                  onClick={toggle}
                  className="flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-800 text-sm text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-200"
                >
                  <PlusIcon className="h-4 w-4" /> Add existing ad set <ChevronDownIcon className="h-4 w-4" />
                </button>
              )}
            >
              {(close) => <ExistingPicker tree={data.adSetTree} used={existingCols} onPick={(o) => { addExisting(o); close(); }} />}
            </Popover>
          </div>
        )}
      </div>

      {editingCol && (
        <LaunchSettingsModal
          audience={editingCol.audience}
          setAudience={(a) => setColAudience(editingCol.id, a)}
          defaultWebsiteUrl={defaultWebsiteUrl}
          name={editingCol.name}
          setName={(n) => setColName(editingCol.id, n)}
          presetId={editingCol.presetId}
          setPresetId={(id) => setColPreset(editingCol.id, id)}
          presets={presets}
          setPresets={setPresets}
          onClose={() => setEditingColId(null)}
        />
      )}

      {formBuilderColId && (
        <LeadFormBuilderModal
          defaultName={(() => { const c = columns.find((x) => x.id === formBuilderColId); return c?.name ? `${c.name} form` : ""; })()}
          editId={formBuilderEditId}
          pageName={data.pages[0]?.name ?? ""}
          onDone={onFormDone}
          onDeleted={(id) => {
            setLeadForms((fs) => fs.filter((f) => f.id !== id));
            setRows((rs) => rs.map((r) => (r.leadFormId === id ? { ...r, leadFormId: null } : r)));
          }}
          onClose={() => { setFormBuilderColId(null); setFormBuilderEditId(null); }}
        />
      )}
    </div>
  );
}

/** One board column (an ad set) or the Unassigned tray. */
function Lane({
  title,
  count,
  header,
  muted,
  highlighted,
  dropHandlers,
  children,
}: {
  title?: string;
  count?: number;
  header?: React.ReactNode;
  muted?: boolean;
  highlighted?: boolean;
  dropHandlers: { onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void };
  children: React.ReactNode;
}) {
  return (
    <div
      {...dropHandlers}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border shadow-xs transition-colors",
        muted ? "border-neutral-800/70 bg-neutral-950/40" : "border-neutral-800 bg-panel",
        highlighted && "border-accent ring-1 ring-accent/40"
      )}
    >
      <div className="border-b border-neutral-800 px-2.5 py-2">
        {header ?? (
          <div className="flex items-center gap-1.5 px-1">
            <span className="mono-label flex-1 truncate">{title}</span>
            {count != null && <span className="shrink-0 tabular-nums rounded bg-neutral-800 px-1.5 text-[10px] text-neutral-400">{count}</span>}
          </div>
        )}
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto p-1.5">{children}</div>
    </div>
  );
}

/** A draggable ad card. */
function Card({
  row,
  creative,
  onDragStart,
  onDragEnd,
  onDelete,
}: {
  row: AdRow;
  creative: UploadedCreative | undefined;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", row.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      className="group flex cursor-grab items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-1.5 shadow-xs transition-colors hover:border-neutral-700 active:cursor-grabbing"
    >
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded ring-1 ring-inset ring-neutral-700">
        {creative?.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={creative.previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-neutral-800 text-neutral-400">
            <VideoIcon className="h-4 w-4" />
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={row.name}>{row.name}</span>
      <button
        onClick={onDelete}
        aria-label="Remove ad from launch"
        className="shrink-0 rounded p-1 text-neutral-600 opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Grouped, searchable list of existing ad sets to add as a column. */
function ExistingPicker({ tree, used, onPick }: { tree: AdSetupData["adSetTree"]; used: AdSetOption[]; onPick: (o: AdSetOption) => void }) {
  const [q, setQ] = useState("");
  const usedIds = new Set(used.map((u) => u.id));
  if (tree.length === 0) {
    return <div className="px-3 py-6 text-center text-xs text-neutral-600">Connect an ad account to load campaigns and ad sets.</div>;
  }
  return (
    <>
      <div className="sticky top-0 flex items-center gap-2 bg-[#242424] px-2 py-1.5">
        <SearchIcon className="h-3.5 w-3.5 text-neutral-500" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search ad sets..."
          className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
        />
      </div>
      {tree.map((g) => {
        const sets = g.adSets.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
        if (sets.length === 0) return null;
        return (
          <div key={g.campaignId}>
            <div className="mono-label truncate px-3 pb-0.5 pt-2">{g.campaignName}</div>
            {sets.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-neutral-200 hover:bg-[#2e2e2e]"
              >
                <CheckBox checked={usedIds.has(s.id)} />
                <span className="truncate">{s.name}</span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}
