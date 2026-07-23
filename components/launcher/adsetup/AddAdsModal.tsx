"use client";

import { useRef, useState } from "react";
import { cn } from "@/components/ui";
import { UploadIcon, FolderIcon, ImageIcon, VideoIcon } from "../icons";
import { filesToCreatives } from "../ImportZone";
import { ModalCard } from "./ModalCard";
import type { UploadedCreative } from "../types";

export function AddAdsModal({ onAdd, onClose }: { onAdd: (creatives: UploadedCreative[]) => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handle(files: FileList | null) {
    if (!files || files.length === 0) return;
    const { creatives, rejected } = filesToCreatives(files);
    if (creatives.length) onAdd(creatives);
    // Keep the modal open to show the skip notice when some files were rejected; otherwise close.
    if (rejected.length) setError(`Skipped: ${rejected.join(", ")}`);
    else onClose();
  }

  return (
    <ModalCard title="Add More Ads" onClose={onClose} width="max-w-lg">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handle(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-accent bg-accent/5" : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900/40"
        )}
      >
        <span className={cn("flex h-12 w-12 items-center justify-center rounded-lg transition-colors", dragging ? "bg-accent/20 text-accent" : "bg-neutral-800 text-neutral-300")}>
          <UploadIcon className="h-5 w-5" />
        </span>
        <div className="mt-3 text-sm font-semibold text-neutral-100">Drag and drop your creatives</div>
        <div className="mt-1 text-xs text-neutral-500">or browse files</div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
          className="mt-4 inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
        >
          <FolderIcon className="h-4 w-4" /> Browse Files
        </button>
        <div className="mt-5 w-full border-t border-neutral-800/80 pt-4">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-neutral-500">
            <span className="inline-flex items-center gap-1.5">
              <ImageIcon className="h-3.5 w-3.5" /> JPG, PNG, WebP
            </span>
            <span className="inline-flex items-center gap-1.5">
              <VideoIcon className="h-3.5 w-3.5" /> MP4, MOV, WebM
            </span>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
          multiple
          className="hidden"
          onChange={(e) => {
            handle(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
    </ModalCard>
  );
}
