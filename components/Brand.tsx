import fs from "fs";
import path from "path";

/**
 * Inlines an SVG from /public into the DOM (not via <img>), so SVGs that color
 * their artwork through an internal <mask>/<filter> render correctly. This lets
 * the real Miraside brand files be dropped in at /public with zero code changes.
 */
function inlineSvg(file: string): string | null {
  try {
    let s = fs.readFileSync(path.join(process.cwd(), "public", file), "utf8");
    // Strip fixed width/height on the root <svg> so it scales to its container.
    s = s.replace(/(<svg\b[^>]*?)\swidth="[^"]*"/i, "$1").replace(/(<svg\b[^>]*?)\sheight="[^"]*"/i, "$1");
    return s;
  } catch {
    return null;
  }
}

export function LogoWordmark({ className = "" }: { className?: string }) {
  const svg = inlineSvg("logo-white.svg");
  if (!svg) {
    return <span className="text-sm font-semibold tracking-tight text-neutral-100">miraside</span>;
  }
  return (
    <span
      className={`inline-flex items-center [&>svg]:h-full [&>svg]:w-auto ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function LogoMark({ className = "" }: { className?: string }) {
  const svg = inlineSvg("mark-white.svg");
  if (!svg) return null;
  return (
    <span
      className={`inline-flex items-center justify-center [&>svg]:h-full [&>svg]:w-auto ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
