import type { Flag, FlagTone } from "@/lib/flags";
import { TEXT_TONE, type Tone } from "@/lib/tone";

export function cn(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

/**
 * Supabase-style button recipes (see DESIGN-SYSTEM.md). Compact (28px), bordered, quiet.
 * Use as: className={BTN.primary} — add h-8/h-9 + text-sm overrides only for page-level CTAs/auth.
 */
export const BTN = {
  base: "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-xs font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  primary:
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent text-[#161616] h-7 px-2.5 text-xs font-medium transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 text-neutral-100 h-7 px-2.5 text-xs font-medium transition-colors hover:bg-neutral-700/50 hover:border-neutral-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  ghost:
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-800 bg-transparent text-neutral-300 h-7 px-2.5 text-xs font-medium transition-colors hover:bg-surface-200 hover:text-neutral-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  danger:
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 text-rose-400 h-7 px-2.5 text-xs font-medium transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
};

/** Input recipe — Studio's bg-control (#242424) + border-control (#393939), 34px (see DESIGN-SYSTEM.md). */
export const INPUT =
  "h-[34px] rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20";

/**
 * Slim Supabase Studio page header: 56px strip with the title and description inline,
 * bottom border, right slot for meta/actions. Full-bleeds out of the standard
 * `px-6 pt-*` page container via negative margins.
 */
export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <header className="-mx-6 flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-neutral-800 px-6 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h1 className="text-sm font-medium text-neutral-50">{title}</h1>
        {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2 text-xs text-neutral-500">{right}</div>}
    </header>
  );
}

/** Muted mono kicker for sections / stat labels / table headers. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mono-label">{children}</h2>;
}

/** White mono title for card header strips. */
export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mono-title">{children}</h3>;
}

export function Kpi({
  label,
  value,
  sub,
  muted,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  tone?: Tone;
}) {
  const color = muted ? "text-neutral-500" : tone ? TEXT_TONE[tone] : "text-neutral-50";
  // Reference stat tile: big medium-weight value on top, muted mono label below.
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3.5 shadow-xs">
      <div className={cn("text-2xl font-medium tabular-nums", color)}>{value}</div>
      <div className="mono-label mt-1">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}{/* neutral-500 clears WCAG AA; -600 (#707070) failed on card surfaces (C58) */}
    </div>
  );
}

export function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

// Supabase badges are tonal AND bordered: hue bg at 10%, border at 30%, text at the 300 shade.
export const TONE_STYLE: Record<FlagTone, string> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  danger: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  neutral: "border-neutral-700 bg-neutral-500/10 text-neutral-400",
};

export function FlagBadge({ flag }: { flag: Flag }) {
  return (
    <span
      title={flag.reason}
      className={cn(
        "inline-flex cursor-default items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_STYLE[flag.tone]
      )}
    >
      {flag.label}
    </span>
  );
}
