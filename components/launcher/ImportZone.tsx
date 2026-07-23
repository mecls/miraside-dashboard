"use client";

import { useRef, useState } from "react";
import { cn } from "@/components/ui";
import { UploadIcon, FolderIcon, ImageIcon, VideoIcon } from "./icons";
import type { UploadedCreative } from "./types";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
// Globally-unique creative ids. A module counter reset to 0 on page load would collide with a resumed
// draft's persisted ids (c1, c2…) and launch the wrong image via the byId map — UUIDs can't collide (C48).
const newCreativeId = () => `c_${crypto.randomUUID()}`;

/**
 * Map a file's folder path (from a folder import) to the ad-set bucket it belongs to.
 * `id` = the stable leaf-directory path; `name` = a short "Ângulo N · <leaf>" label parsed from the path.
 * Returns null for a flat (no-folder) import.
 */
export function deriveBucket(relativePath: string): { id: string; name: string } | null {
  if (!relativePath) return null;
  const segs = relativePath.split("/").filter(Boolean);
  if (segs.length < 2) return null; // just a filename — no folder context
  const dirSegs = segs.slice(0, -1); // drop the filename
  const leaf = dirSegs[dirSegs.length - 1]; // the immediate folder that holds the image
  const id = dirSegs.join("/");
  // Find an "Ângulo N" (accent- and case-insensitive) among the folder segments.
  let angle: string | null = null;
  for (const s of dirSegs) {
    const m = s.match(/(?:â|a)ngulo\s*(\d+)/i);
    if (m) { angle = `Ângulo ${m[1]}`; break; }
  }
  const name = angle
    ? `${angle} · ${leaf}`
    : dirSegs.length >= 2
    ? `${dirSegs[dirSegs.length - 2]} · ${leaf}`
    : leaf;
  return { id, name };
}

/** Validate dropped/picked files, build in-browser creative objects, and report skips.
 *  `paths` (optional, parallel to `files`) supplies each file's folder path for drag-dropped folders,
 *  where `webkitRelativePath` isn't populated; otherwise we read `webkitRelativePath` (folder <input>). */
export function filesToCreatives(files: FileList | File[], paths?: string[]): { creatives: UploadedCreative[]; rejected: string[] } {
  const creatives: UploadedCreative[] = [];
  const rejected: string[] = [];
  Array.from(files).forEach((file, i) => {
    // Silently skip macOS/hidden junk that a folder import drags in (.DS_Store etc.).
    if (file.name.startsWith(".")) return;
    const isImage = IMAGE_TYPES.includes(file.type);
    const isVideo = VIDEO_TYPES.includes(file.type);
    if (!isImage && !isVideo) {
      rejected.push(`${file.name} (unsupported)`);
      return;
    }
    if (file.size > MAX_BYTES) {
      rejected.push(`${file.name} (over 100 MB)`);
      return;
    }
    const rel = paths?.[i] ?? (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const b = deriveBucket(rel);
    creatives.push({
      id: newCreativeId(),
      file,
      name: file.name,
      kind: isImage ? "image" : "video",
      previewUrl: URL.createObjectURL(file),
      size: file.size,
      bucket: b?.id ?? null,
      bucketName: b?.name ?? null,
    });
  });
  return { creatives, rejected };
}

type Picked = { file: File; path: string };

/** Recursively read a drag-dropped FileSystemEntry into files carrying their relative folder path. */
async function readEntry(entry: any, prefix: string, out: Picked[]): Promise<void> {
  if (!entry) return;
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix ? `${prefix}/${file.name}` : file.name });
  } else if (entry.isDirectory) {
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const reader = entry.createReader();
    const readBatch = (): Promise<any[]> => new Promise((res, rej) => reader.readEntries(res, rej));
    // readEntries returns in batches — keep calling until it yields an empty batch.
    let batch = await readBatch();
    while (batch.length) {
      for (const e of batch) await readEntry(e, childPrefix, out);
      batch = await readBatch();
    }
  }
}

export function ImportZone({ onAdd }: { onAdd: (creatives: UploadedCreative[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function emit(res: { creatives: UploadedCreative[]; rejected: string[] }) {
    setError(res.rejected.length ? `Skipped: ${res.rejected.join(", ")}` : null);
    if (res.creatives.length) onAdd(res.creatives);
  }
  function handle(files: FileList | null) {
    if (!files || files.length === 0) return;
    emit(filesToCreatives(files));
  }
  function handlePicked(picked: Picked[]) {
    if (!picked.length) return;
    emit(filesToCreatives(picked.map((p) => p.file), picked.map((p) => p.path)));
  }

  return (
    <div>
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
          // Ignore leave events fired when the pointer crosses onto a child element.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          // Capture the DataTransfer synchronously — it's cleared once the handler awaits.
          const dtFiles = e.dataTransfer.files;
          const items = e.dataTransfer.items;
          const entries = items ? Array.from(items).map((it) => it.webkitGetAsEntry?.()).filter(Boolean) : [];
          if (entries.some((en: any) => en?.isDirectory)) {
            const out: Picked[] = [];
            for (const en of entries) await readEntry(en, "", out);
            handlePicked(out);
          } else {
            handle(dtFiles);
          }
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors shadow-xs",
          dragging ? "border-accent bg-accent/5" : "border-neutral-800 bg-neutral-900 hover:border-neutral-700 hover:bg-surface-200"
        )}
      >
        <span
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-lg transition-colors",
            dragging ? "bg-accent/20 text-accent" : "bg-neutral-800/80 text-neutral-400"
          )}
        >
          <UploadIcon className="h-6 w-6" />
        </span>
        <div className="mt-4 text-sm font-medium text-neutral-100">Drag and drop your creatives</div>
        <div className="mt-1 text-xs text-neutral-500">or drop a whole folder — one ad set per subfolder</div>

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none"
          >
            <FolderIcon className="h-3.5 w-3.5" />
            Browse files
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              folderRef.current?.click();
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none"
          >
            <FolderIcon className="h-3.5 w-3.5" />
            Import folder
          </button>
        </div>

        <div className="mt-6 w-full border-t border-neutral-800/80 pt-5">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-neutral-500">
            <span className="inline-flex items-center gap-1.5">
              <ImageIcon className="h-3.5 w-3.5" /> JPG, PNG, WebP
            </span>
            <span className="inline-flex items-center gap-1.5">
              <VideoIcon className="h-3.5 w-3.5" /> MP4, MOV, WebM
            </span>
            <span className="text-neutral-600">Max 100.0 MB per file</span>
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
        {/* Folder picker: yields every file inside with webkitRelativePath so we can bucket by subfolder. */}
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            handle(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="mt-2 text-xs text-rose-400">{error}</div>}
    </div>
  );
}
