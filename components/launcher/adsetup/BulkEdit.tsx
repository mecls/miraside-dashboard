"use client";

import { useState } from "react";
import { cn } from "@/components/ui";
import { PencilIcon, ChevronDownIcon, PlusIcon, XIcon } from "../icons";
import { Popover, Select, CheckBox } from "./Select";
import { Toggle } from "./cells";
import { ModalCard } from "./ModalCard";
import { CTA_OPTIONS, allowsVariations } from "./constants";
import type { AdRow, AdFormat, AdStatus, AdSetupData, AdSetGroup } from "../types";

export type BulkField =
  | "name"
  | "status"
  | "primaryText"
  | "headline"
  | "description"
  | "link"
  | "utm"
  | "cta"
  | "facebookPage"
  | "leadForm"
  | "enhancements"
  | "adSets";

const LABEL: Record<BulkField, string> = {
  name: "Ad Name",
  status: "Status",
  primaryText: "Primary Text",
  headline: "Headline",
  description: "Description",
  link: "Link",
  utm: "UTM Tags",
  cta: "Call to Action",
  facebookPage: "Facebook Page",
  leadForm: "Lead Form",
  enhancements: "Enhancements",
  adSets: "Ad Sets",
};

const BULK_FIELDS: BulkField[] = [
  "name",
  "primaryText",
  "headline",
  "description",
  "link",
  "cta",
  "facebookPage",
  "leadForm",
  "enhancements",
  "utm",
  "adSets",
];

const VAR_FIELDS = new Set<BulkField>(["primaryText", "headline", "description"]);
const INPUT = "w-full rounded-md border border-neutral-700 bg-surface-200 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20";

function applyVars(format: AdFormat, existing: string[], added: string[]): string[] {
  const a = added.map((v) => v.trim()).filter(Boolean);
  if (!allowsVariations(format)) return [a[0] ?? existing[0] ?? ""];
  const e = existing.map((v) => v.trim()).filter(Boolean);
  const merged = [...e, ...a].slice(0, 5);
  return merged.length ? merged : [""];
}

export function BulkEditMenu({ count, onPick }: { count: number; onPick: (f: BulkField) => void }) {
  return (
    <Popover
      width={224}
      align="left"
      trigger={({ open, toggle, ref }) => (
        <button
          ref={ref}
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100"
        >
          <PencilIcon className="h-3.5 w-3.5" /> Bulk Edit <ChevronDownIcon className="h-3.5 w-3.5" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="mono-label px-3 py-1.5">
            Edit {count} ad{count === 1 ? "" : "s"}
          </div>
          {BULK_FIELDS.map((f) => (
            <button
              key={f}
              onClick={() => {
                onPick(f);
                close();
              }}
              className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-neutral-200 transition-colors hover:bg-[#2e2e2e]"
            >
              {LABEL[f]}
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

export function BulkEditModal({
  field,
  count,
  format,
  data,
  onApply,
  onClose,
}: {
  field: BulkField;
  count: number;
  format: AdFormat;
  data: AdSetupData;
  onApply: (fn: (row: AdRow) => Partial<AdRow>) => void;
  onClose: () => void;
}) {
  const label = LABEL[field];
  const isVarField = VAR_FIELDS.has(field);
  // Only the variation formats (single/flexible) get the multi-variation editor; others edit one value.
  const showVariations = isVarField && allowsVariations(format);

  const [text, setText] = useState("");
  const [status, setStatus] = useState<AdStatus>("PAUSED");
  const [cta, setCta] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(data.pages[0]?.id ?? null);
  const [leadForm, setLeadForm] = useState<string | null>(null);
  const [enh, setEnh] = useState(true);
  const [vars, setVars] = useState<string[]>([""]);
  const [adSetIds, setAdSetIds] = useState<string[]>([]);

  const varCount = vars.map((v) => v.trim()).filter(Boolean).length;

  function buildFn(): (row: AdRow) => Partial<AdRow> {
    switch (field) {
      case "name":
        return () => ({ name: text.trim() });
      case "link":
        return () => ({ link: text.trim() });
      case "utm":
        return () => ({ utm: text.trim() });
      case "status":
        return () => ({ status });
      case "cta":
        return () => ({ cta: cta ?? "LEARN_MORE" });
      case "facebookPage":
        return () => ({ facebookPageId: pageId });
      case "leadForm":
        return () => ({ leadFormId: leadForm });
      case "enhancements":
        return () => ({ enhancements: enh });
      case "primaryText":
        return (r) => ({ primaryText: applyVars(r.format, r.primaryText, vars) });
      case "headline":
        return (r) => ({ headline: applyVars(r.format, r.headline, vars) });
      case "description":
        return (r) => ({ description: applyVars(r.format, r.description, vars) });
      case "adSets":
        return (r) => ({ adSetIds: Array.from(new Set([...r.adSetIds, ...adSetIds])) });
    }
  }

  const canApply = (() => {
    switch (field) {
      case "name":
      case "link":
      case "utm":
        return text.trim().length > 0;
      case "cta":
        return !!cta;
      case "facebookPage":
        return !!pageId;
      case "leadForm":
        return !!leadForm;
      case "primaryText":
      case "headline":
      case "description":
        return varCount > 0;
      case "adSets":
        return adSetIds.length > 0;
      default:
        return true; // status / enhancements
    }
  })();

  const applyLabel = showVariations
    ? `Add ${varCount} variation${varCount === 1 ? "" : "s"} to ${count} ad${count === 1 ? "" : "s"}`
    : `Apply to ${count} ad${count === 1 ? "" : "s"}`;

  return (
    <ModalCard
      title={`${showVariations ? "Add" : "Edit"} ${label}`}
      subtitle={`Apply to ${count} selected ad${count === 1 ? "" : "s"}`}
      onClose={onClose}
      width={field === "adSets" ? "max-w-lg" : "max-w-md"}
      footer={
        <>
          <button onClick={onClose} className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent px-2.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none">
            Cancel
          </button>
          <button
            onClick={() => onApply(buildFn())}
            disabled={!canApply}
            className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 disabled:opacity-50 focus-visible:outline-none"
          >
            {applyLabel}
          </button>
        </>
      }
    >
      {(field === "name" || field === "link" || field === "utm") && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-neutral-200">{label}</label>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={field === "link" ? "https://..." : field === "utm" ? "utm_source=..." : ""}
            className={INPUT}
          />
        </div>
      )}

      {field === "status" && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-neutral-200">Set Status</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setStatus("ACTIVE")}
              className={cn(
                "flex h-8 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors",
                status === "ACTIVE" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-neutral-800 bg-transparent text-neutral-300 hover:bg-surface-200 hover:text-neutral-100"
              )}
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400" /> Active
            </button>
            <button
              onClick={() => setStatus("PAUSED")}
              className={cn(
                "flex h-8 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors",
                status === "PAUSED" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-neutral-800 bg-transparent text-neutral-300 hover:bg-surface-200 hover:text-neutral-100"
              )}
            >
              <span className="h-2 w-2 rounded-full bg-amber-400" /> Paused
            </button>
          </div>
        </div>
      )}

      {field === "cta" && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-neutral-200">Select Call to Action</label>
          <Select value={cta} onChange={setCta} options={CTA_OPTIONS} placeholder="Select CTA..." />
        </div>
      )}

      {field === "facebookPage" && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-neutral-200">Select Facebook Page</label>
          <Select value={pageId} onChange={setPageId} options={data.pages} placeholder="Select page..." searchable />
        </div>
      )}

      {field === "leadForm" && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-neutral-200">Select Lead Form</label>
          <Select value={leadForm} onChange={setLeadForm} options={data.leadForms} placeholder={data.leadForms.length ? "Select lead form..." : "No lead forms found"} searchable />
        </div>
      )}

      {field === "enhancements" && (
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-neutral-200">Enhancements</div>
          <Toggle on={enh} onChange={setEnh} label="Creative enhancements" />
        </div>
      )}

      {showVariations && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-neutral-200">{label} Variations</div>
          <p className="text-xs text-neutral-500">Add up to 5 variations to the selected ads.</p>
          {vars.map((v, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-2 text-xs text-neutral-600">{i + 1}.</span>
              <textarea
                value={v}
                onChange={(e) => setVars((vs) => vs.map((x, j) => (j === i ? e.target.value : x)))}
                rows={2}
                placeholder={`Enter ${label.toLowerCase()}...`}
                className={cn(INPUT, "resize-none")}
              />
              {vars.length > 1 && (
                <button onClick={() => setVars((vs) => vs.filter((_, j) => j !== i))} aria-label="Remove variation" className="mt-2 text-neutral-600 hover:text-rose-400">
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {vars.length < 5 && (
            <button onClick={() => setVars((vs) => [...vs, ""])} className="inline-flex items-center gap-1 text-xs text-neutral-500 transition-colors hover:text-accent">
              <PlusIcon className="h-3 w-3" /> Add another variation (<span className="tabular-nums">{vars.length}/5</span>)
            </button>
          )}
        </div>
      )}

      {isVarField && !showVariations && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-neutral-200">{label}</label>
          <textarea
            autoFocus
            value={vars[0] ?? ""}
            onChange={(e) => setVars([e.target.value])}
            rows={3}
            placeholder={`Enter ${label.toLowerCase()}...`}
            className={cn(INPUT, "resize-none")}
          />
        </div>
      )}

      {field === "adSets" && <AdSetPicker tree={data.adSetTree} value={adSetIds} onChange={setAdSetIds} />}
    </ModalCard>
  );
}

function AdSetPicker({ tree, value, onChange }: { tree: AdSetGroup[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  const matches = (s: { name: string; active?: boolean }) =>
    (!q || s.name.toLowerCase().includes(q.toLowerCase())) && (!activeOnly || s.active);
  const visibleIds = tree.flatMap((g) => g.adSets.filter(matches)).map((s) => s.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => value.includes(id));

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }
  function selectAll() {
    onChange(allSelected ? value.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...value, ...visibleIds])));
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">Selected ad sets will be added to all chosen ads.</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaigns or ad sets..." className={INPUT} />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="h-4 w-4 accent-[#3ECF8E]" /> Show active only
        </label>
        <button onClick={selectAll} className="h-6 rounded-md border border-transparent bg-accent px-2 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600">
          {allSelected ? "Clear" : "Select all"} ({visibleIds.length})
        </button>
      </div>
      <div className="max-h-64 overflow-auto rounded-lg border border-neutral-800 shadow-xs">
        {tree.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-neutral-600">Connect an ad account to load campaigns and ad sets.</div>
        ) : (
          tree.map((g) => {
            const sets = g.adSets.filter(matches);
            if (sets.length === 0) return null;
            return (
              <div key={g.campaignId}>
                <div className="mono-label truncate px-3 pb-1 pt-2">{g.campaignName}</div>
                {sets.map((s) => (
                  <button key={s.id} onClick={() => toggle(s.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-200 transition-colors hover:bg-surface-200">
                    <CheckBox checked={value.includes(s.id)} />
                    <span className="truncate">{s.name}</span>
                    {s.active && (
                      <span className="ml-auto inline-flex shrink-0 items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                        active
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
