"use client";

import { useEffect, useRef, useState } from "react";
import type { EditorSetting } from "@/lib/settings-editor";
import { cn } from "./ui";
import { AppSelect } from "./AppSelect";

function category(key: string): string {
  if (key.startsWith("wa_tpl_")) return "WhatsApp messages";
  if (key === "default_website_url" || key === "privacy_policy_url") return "Links & URLs";
  if (key.startsWith("target") || key === "deal_cycle_days" || key === "rel_roas_baseline") return "Your targets";
  if (key.startsWith("d12_") || key.startsWith("small_sample")) return "When to start judging an ad";
  if (key.startsWith("d1_") || key === "d2_freq_max" || key === "d3_freq_min" || key === "d5_freq_min")
    return "Audience freshness (frequency)";
  if (key.startsWith("d4_")) return "Creative fatigue";
  if (key === "d5_reach_growth_max_pct" || key === "d5_trailing_window_days") return "Audience saturation";
  if (key === "d2_spend_share_min_pct" || key === "d2_rel_roas_max" || key === "d6_spend_share_max_pct" || key === "d6_cpr_ratio_max")
    return "Feeders & niche pockets";
  if (key.startsWith("d7_")) return "Weak metric but good result";
  if (key.startsWith("d8_")) return "Delivery cost (CPM)";
  if (key.startsWith("d10_") || key === "d3_roas_min") return "Kill / reallocate & retargeting";
  if (key === "d11_emq_min") return "Tracking health";
  if (key.startsWith("d13_")) return "Budget scaling";
  if (key.startsWith("d14_")) return "Late conversions";
  if (key === "reporting_window_days" || key === "capture_rate_warn_pct") return "Reporting & data trust";
  return "Other";
}

const GROUP_ORDER = [
  "WhatsApp messages",
  "Links & URLs",
  "Your targets",
  "When to start judging an ad",
  "Audience freshness (frequency)",
  "Creative fatigue",
  "Audience saturation",
  "Feeders & niche pockets",
  "Weak metric but good result",
  "Delivery cost (CPM)",
  "Kill / reallocate & retargeting",
  "Budget scaling",
  "Tracking health",
  "Late conversions",
  "Reporting & data trust",
  "Other",
];

/**
 * The WhatsApp messages read as a sequence — first contact, then the chases, then the meeting ones.
 * Sorting them by key (the default) put "Remarcar" first and "Primeiro contacto" third, which reads
 * as random. Everything else keeps its existing key order.
 */
const WA_ORDER = [
  "wa_tpl_first_contact",
  "wa_tpl_no_answer",
  "wa_tpl_last_attempt",
  "wa_tpl_confirm",
  "wa_tpl_waiting",
  "wa_tpl_no_show",
  "wa_tpl_cancelled",
];

export function SettingsForm({ settings, canEdit = true }: { settings: EditorSetting[]; canEdit?: boolean }) {
  const groups = new Map<string, EditorSetting[]>();
  for (const s of settings) {
    const c = category(s.key);
    const arr = groups.get(c) ?? [];
    arr.push(s);
    groups.set(c, arr);
  }
  const waRank = (k: string) => {
    const i = WA_ORDER.indexOf(k);
    return i < 0 ? 99 : i;
  };
  for (const [name, arr] of groups) {
    if (name === "WhatsApp messages") arr.sort((a, b) => waRank(a.key) - waRank(b.key));
  }
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a);
    const bi = GROUP_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  return (
    <div className="space-y-8">
      {orderedGroups.map((g) => (
        <div key={g}>
          <h3 className="mono-label">{g}</h3>
          <div className="mt-3 divide-y divide-neutral-800/70 rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
            {groups.get(g)!.map((s) => (
              <Row key={s.key} s={s} canEdit={canEdit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({ s, canEdit }: { s: EditorSetting; canEdit: boolean }) {
  const [val, setVal] = useState<any>(s.current);
  const [overridden, setOverridden] = useState(s.overridden);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function save(newVal: any, prevVal?: any) {
    setStatus("saving");
    setErr(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: s.key, value: newVal }),
      });
      const j = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErr(j.error ?? "Save failed");
        if (prevVal !== undefined) setVal(prevVal); // revert the optimistic change so the UI never shows an unsaved value (C51)
      } else {
        setStatus("saved");
        if (newVal === null) {
          setVal(s.default_value);
          setOverridden(false);
        } else {
          setOverridden(true);
        }
        setTimeout(() => setStatus("idle"), 1600);
      }
    } catch (e: any) {
      setStatus("error");
      setErr(e?.message ?? "Network error");
      if (prevVal !== undefined) setVal(prevVal); // revert optimistic change on network failure (C51)
    }
  }

  const min = s.suggested_min != null ? Number(s.suggested_min) : undefined;
  const max = s.suggested_max != null ? Number(s.suggested_max) : undefined;

  // A multi-line message can't live in the label-left / control-right row the numeric settings use —
  // squeezed into that column it clipped after three lines and wrapped inconsistently between rows.
  if (s.value_type === "longtext") {
    return (
      <LongTextRow
        s={s}
        canEdit={canEdit}
        val={val}
        setVal={setVal}
        save={save}
        status={status}
        err={err}
        overridden={overridden}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-100" title={s.key}>
            {s.label.replace(/^D\d+\s+/, "")}
          </span>
          {overridden && <span className="text-[10px] text-amber-400">custom</span>}
        </div>
        {s.used_by && <div className="mt-0.5 truncate text-xs text-neutral-600">{s.used_by}</div>}
      </div>

      <div className="flex items-center gap-2">
        {s.value_type === "boolean" ? (
          <button
            disabled={!canEdit}
            onClick={() => {
              const prev = val;
              const nv = !val;
              setVal(nv);
              save(nv, prev);
            }}
            className={cn(
              "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              val
                ? "border-neutral-700 bg-neutral-700/30 text-neutral-100 hover:border-neutral-600 hover:bg-neutral-700/50"
                : "border-neutral-800 bg-transparent text-neutral-300 hover:bg-surface-200 hover:text-neutral-100"
            )}
          >
            {val ? "on" : "off"}
          </button>
        ) : s.value_type === "enum" ? (
          // Match the number controls' footprint.
          <AppSelect
            disabled={!canEdit}
            value={String(val)}
            onChange={(v) => {
              const prev = val;
              setVal(v);
              save(v, prev);
            }}
            className="w-[8.375rem]"
            options={(s.enum_options ?? []).map((o) => ({ value: o, label: o }))}
          />
        ) : s.value_type === "url" || s.value_type === "text" ? (
          <input
            type={s.value_type === "url" ? "url" : "text"}
            disabled={!canEdit}
            value={val ?? ""}
            placeholder={s.value_type === "url" ? "https://…" : ""}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => {
              if (String(val).trim() !== String(s.current) && String(val).trim() !== "") save(String(val).trim());
            }}
            className="h-[34px] w-72 max-w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              disabled={!canEdit}
              value={val}
              min={min}
              max={max}
              step="any"
              onChange={(e) => setVal(e.target.value)}
              onBlur={() => {
                if (String(val) !== String(s.current)) save(val);
              }}
              className="h-[34px] w-24 rounded-md border border-neutral-700 bg-surface-200 px-3 text-right text-sm tabular-nums text-neutral-100 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="w-8 text-xs text-neutral-600">{s.unit}</span>
          </div>
        )}

        <div className="w-16 text-right text-[11px]">
          {status === "saving" && <span className="text-neutral-500">saving…</span>}
          {status === "saved" && <span className="text-emerald-400">saved</span>}
          {status === "error" && <span className="text-rose-400" title={err ?? ""}>error</span>}
          {status === "idle" && overridden && canEdit && (
            <button onClick={() => save(null)} className="text-neutral-500 hover:text-neutral-300">
              reset
            </button>
          )}
        </div>
      </div>

      {err && <div className="w-full text-right text-[11px] text-rose-400">{err}</div>}
    </div>
  );
}

/**
 * A multi-line setting (the WhatsApp messages): label on top, the message full-width underneath.
 *
 * The shared row puts a small control to the RIGHT of the label — fine for a number, wrong for a
 * paragraph: the box ended up ~400px wide and three lines tall, so most of the message was hidden
 * behind a scrollbar and one row wrapped under its own label. Here the message gets the whole width
 * and the box grows to fit its content, so you always see the entire thing you're about to send.
 */
function LongTextRow({
  s,
  canEdit,
  val,
  setVal,
  save,
  status,
  err,
  overridden,
}: {
  s: EditorSetting;
  canEdit: boolean;
  val: any;
  setVal: (v: any) => void;
  save: (v: any, prev?: any) => Promise<void>;
  status: "idle" | "saving" | "saved" | "error";
  err: string | null;
  overridden: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = String(val ?? "");

  // Grow to the content instead of scrolling inside a fixed box. Re-measured on every change and on
  // mount, so a long message is fully visible without dragging the resize handle.
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 72)}px`;
  };
  useEffect(fit, [text]);

  const dirty = text.trim() !== String(s.current ?? "").trim();
  const commit = () => {
    if (dirty && text.trim() !== "") save(text.trim());
  };

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-100" title={s.key}>
            {s.label}
          </span>
          {overridden && <span className="text-[10px] text-amber-400">custom</span>}
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          {status === "saving" && <span className="text-neutral-500">saving…</span>}
          {status === "saved" && <span className="text-emerald-400">saved</span>}
          {status === "error" && <span className="text-rose-400" title={err ?? ""}>error</span>}
          {status === "idle" && dirty && canEdit && <span className="text-amber-400">unsaved</span>}
          {status === "idle" && !dirty && overridden && canEdit && (
            <button onClick={() => save(null)} className="text-neutral-500 hover:text-neutral-300">
              reset
            </button>
          )}
        </div>
      </div>
      {s.used_by && <div className="mt-0.5 text-xs text-neutral-600">{s.used_by}</div>}

      <textarea
        ref={ref}
        disabled={!canEdit}
        value={text}
        rows={2}
        spellCheck
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter saves without leaving the box; Escape abandons the edit.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commit();
            ref.current?.blur();
          } else if (e.key === "Escape") {
            setVal(s.current);
            ref.current?.blur();
          }
        }}
        className="mt-2 block w-full resize-none overflow-hidden rounded-md border border-neutral-700 bg-surface-200 px-3 py-2 text-sm leading-relaxed text-neutral-100 focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
      />

      {err && <div className="mt-1 text-[11px] text-rose-400">{err}</div>}
    </div>
  );
}
