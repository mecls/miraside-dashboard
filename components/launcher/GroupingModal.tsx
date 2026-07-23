"use client";

import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { PlusIcon } from "./icons";
import { ModalShell, ModalHeader, ModalFooter, Divider, CreativeThumb, GroupCard, newGroupId } from "./GroupingShared";
import { useRatios } from "./ratio";
import type { UploadedCreative, Group } from "./types";

type Mode = "multi_ratio" | "flexible";

const CONFIG: Record<
  Mode,
  {
    title: string;
    grouped: (k: number) => string;
    groupedHelp: string;
    groupLabel: (n: number) => string;
    hint: string;
    createLabel: (n: number) => string;
    minSelect: number;
    maxSelect: number;
  }
> = {
  multi_ratio: {
    title: "Multi-Ratio Ads",
    grouped: (k) => `${k} multi-ratio ad${k === 1 ? "" : "s"} created.`,
    groupedHelp: 'Click "Ungroup" to split them back into individual creatives.',
    groupLabel: (n) => `${n} ratios`,
    hint: "Select 2-3 creatives with different ratios to group them into a multi-ratio ad.",
    createLabel: (n) => `Create Multi-Ratio (${n})`,
    minSelect: 2,
    maxSelect: 3,
  },
  flexible: {
    title: "Flexible Ads",
    grouped: (k) => `${k} flexible ad${k === 1 ? "" : "s"} created.`,
    groupedHelp: "Select ungrouped creatives below to create more.",
    groupLabel: (n) => `${n} creatives`,
    hint: "Select multiple creatives to group them into a flexible ad. Meta will optimize which to show.",
    createLabel: (n) => `Create Flexible (${n})`,
    minSelect: 2,
    maxSelect: Number.POSITIVE_INFINITY,
  },
};

export function GroupingModal({
  creatives,
  mode,
  groups,
  setGroups,
  onBack,
  onClose,
  onContinue,
}: {
  creatives: UploadedCreative[];
  mode: Mode;
  groups: Group[];
  setGroups: Dispatch<SetStateAction<Group[]>>;
  onBack: () => void;
  onClose: () => void;
  onContinue: (adCount: number) => void;
}) {
  const cfg = CONFIG[mode];
  const ratios = useRatios(creatives);
  const byId = useMemo(() => new Map(creatives.map((c) => [c.id, c])), [creatives]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groupedIds = useMemo(() => new Set(groups.flatMap((g) => g.creativeIds)), [groups]);
  const ungrouped = creatives.filter((c) => !groupedIds.has(c.id));
  const adCount = groups.length + ungrouped.length;
  const atCap = selected.size >= cfg.maxSelect;
  const canCreate = selected.size >= cfg.minSelect;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < cfg.maxSelect) next.add(id);
      return next;
    });
  }

  function createGroup() {
    if (selected.size < cfg.minSelect) return;
    setGroups((prev) => [...prev, { id: newGroupId(), creativeIds: Array.from(selected) }]);
    setSelected(new Set());
  }

  function ungroup(id: string) {
    setGroups((prev) => prev.filter((g) => g.id !== id));
  }

  return (
    <ModalShell onBackdrop={onClose} ariaLabel={cfg.title}>
      <ModalHeader title={cfg.title} adCount={adCount} onBack={onBack} onClose={onClose} />

      <div className="space-y-6 p-5">
        {groups.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-neutral-400">
              <span className="text-neutral-200">{cfg.grouped(groups.length)}</span> {cfg.groupedHelp}
            </p>
            <div className="flex flex-wrap gap-3">
              {groups.map((g) => (
                <GroupCard
                  key={g.id}
                  label={cfg.groupLabel(g.creativeIds.length)}
                  creatives={g.creativeIds.map((id) => byId.get(id)).filter((c): c is UploadedCreative => !!c)}
                  ratios={ratios}
                  onUngroup={() => ungroup(g.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <Divider label={`Ungrouped (${ungrouped.length})`} />
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-neutral-400">{cfg.hint}</p>
            {canCreate && (
              <button
                onClick={createGroup}
                className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
              >
                <PlusIcon className="h-4 w-4" /> {cfg.createLabel(selected.size)}
              </button>
            )}
          </div>
          {ungrouped.length === 0 ? (
            <p className="text-sm text-neutral-600">All creatives grouped.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {ungrouped.map((c) => (
                <CreativeThumb
                  key={c.id}
                  creative={c}
                  ratio={ratios[c.id]}
                  selected={selected.has(c.id)}
                  onToggle={() => toggle(c.id)}
                  disabled={!selected.has(c.id) && atCap}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ModalFooter adCount={adCount} onContinue={() => onContinue(adCount)} />
    </ModalShell>
  );
}
