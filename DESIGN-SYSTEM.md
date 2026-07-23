# Miraside Design System — Supabase port (source of truth)

Extracted from computed styles of the reference Supabase-style port (arc-outreach-dashboard.vercel.app)
and the supabase/supabase source. Every component in this app must match these recipes exactly.
All values are for the dark theme (the only theme).

## Fonts
- Sans: **Inter variable** (`var(--font-inter)` via next/font) → `font-sans`. Base UI text is SMALL: `text-sm` (14px) for body, `text-xs` (12px) for buttons/meta/descriptions.
- Mono (signature): `ui-monospace, SF Mono, …` → `font-mono`. Used for: card header titles, stat labels, table column headers, code/ids.
- Numbers in tables/stats: `tabular-nums`.

## Colors (Tailwind tokens already mapped)
| Token | Value | Use |
|---|---|---|
| `neutral-950` / `canvas` | `#121212` | app background |
| `panel` | `#171717` | sidebar |
| `neutral-900` / `surface-100` | `#1f1f1f` | cards |
| `surface-200` | `#242424` | hover surface, active nav, count pills |
| `neutral-800` | `#2e2e2e` | default borders |
| `neutral-700` | `#3d3d3d` (≈ #393939 "strong") | button borders, hover borders |
| `neutral-100` | `#ededed` / fg `#fafafa` | primary text |
| `neutral-400` | `#a3a3a3` | secondary text |
| `neutral-500` | `#8f8f8f` (≈ #898989) | muted labels (mono labels, meta) |
| `neutral-600` | `#707070` | subtle/disabled |
| `accent` / `brand` | `#3ECF8E` | primary buttons, links, focus |
| `accent-600` | `#2eb87a` | primary hover |

## Buttons — THE signature. Compact, bordered, quiet. NEVER `rounded-full`, NEVER `font-semibold`, NEVER py-2.5 pills.
All: `inline-flex items-center gap-1.5 rounded-md text-xs font-medium h-7 px-2.5 transition-colors border focus-visible:outline-none` (28px tall; use `h-8 px-3 text-sm` only for page-level CTAs, `h-9` only for auth).
- **Primary (brand):** `bg-accent text-[#161616] border-transparent hover:bg-accent-600` — near-black text on green, NO visible border.
- **Secondary (default):** `bg-neutral-700/30 text-neutral-100 border-neutral-700 hover:bg-neutral-700/50 hover:border-neutral-600` — translucent grey fill + strong border.
- **Outline/ghost row action:** `bg-transparent text-neutral-300 border-neutral-800 hover:bg-surface-200 hover:text-neutral-100`.
- **Destructive:** dark with red text, NOT solid red: `bg-neutral-700/30 text-rose-400 border-neutral-700 hover:border-rose-500/50 hover:bg-rose-500/10`. (Solid rose only for truly irreversible confirm CTAs.)
- Icon-in-button: 14–16px stroke icon, `gap-1.5`.

## Cards / panels
`rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs` (radius 8px, shadow = rgba(0,0,0,.05) 0 1 2).
**Card header strip** (when the card has a title): full-width row `border-b border-neutral-800 px-4 py-3` (or px-5) containing a **mono title**: `font-mono text-xs uppercase tracking-wider text-neutral-100` (FULL-strength white, 12px) + optional right-side action; muted `text-xs text-neutral-500` description under it.

## Stat tiles (KPI)
`rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3.5 shadow-xs`; **VALUE ON TOP**: `text-2xl font-medium tabular-nums` (weight 500, NOT bold/semibold); label BELOW: `.mono-label` = `font-mono text-[11px] uppercase tracking-wider text-neutral-500`. Tone color applies to the value.

## Badges / pills
Tonal AND bordered: `inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium` (Studio's own Badge is even smaller: uppercase text-[10px] tracking-wide — prefer that for STATUS words like ACTIVE/PAUSED/FAILED; keep 12px for longer labels)
+ hue: `border-{hue}-500/30 bg-{hue}-500/10 text-{hue}-300` (green=emerald/brand, amber=warning, rose=danger, indigo=info, **sky=meeting / booked call / audit link**, **violet=follow-up call state**, neutral). sky + violet are official (Miguel, 2026-07-22 — kept rather than folded into indigo).
Optional 6px status dot: `h-1.5 w-1.5 rounded-full bg-{hue}-400`.
Small count pill (nav/tabs): `rounded-full bg-surface-200 px-1.5 text-[11px] text-neutral-500`.

## Inputs / selects / textareas  (VERIFIED against Studio source: bg-control 14.1%, border-control 22.4%, h-[34px])
`h-[34px] rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20`. Textareas same minus height (py-2). Checkboxes: green fill + dark check when on.

**Dropdowns: NEVER a native `<select>`** — its open menu is OS-drawn (Apple-style) and can't be themed. Use `components/AppSelect.tsx` (styled trigger + our own fixed-positioned dark menu; closes on outside click/Esc/scroll). State-colored variants (e.g. the Leads call state) follow the same pattern with a tinted trigger.

## Tables
Container: `overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs`.
Header row (VERIFIED: Studio thead = bg-200 #171717, DARKER than the card): `border-b border-neutral-800 bg-panel` with th `px-4 py-2.5 text-left font-mono text-[11px] uppercase tracking-wider text-neutral-500 font-normal` (first `pl-5`, last `pr-5`).
Body: rows `border-b border-neutral-800 last:border-0 hover:bg-surface-200/50`; td `px-4 py-2.5 text-sm` (numerics `tabular-nums`, first `pl-5`, last `pr-5`).

## Shell
- Sidebar: `w-60` (240px), `bg-panel border-r border-neutral-800`. Brand row h-14 px-5. Nav item: `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-neutral-400 hover:bg-surface-200/60 hover:text-neutral-100`; active: `bg-surface-200 text-neutral-50 font-medium` (icon goes brand-green). Right-aligned count pills.
- Body: `font-weight: 450` (Studio sets this globally; already in globals.css).
- Page header: slim 48px strip (Studio --header-height: 3rem), `border-b border-neutral-800`, containing `text-sm font-medium text-neutral-50` title + `text-xs text-neutral-500` description INLINE (side by side), right slot for meta/buttons. NOT a big h1.

## Modals / popovers
Overlay `bg-black/50 backdrop-blur-[2px]` (Studio: black/40 + blur-xs). Panel (VERIFIED: Studio dialog bg = dash-sidebar #171717, DARKER than cards): `rounded-lg border border-neutral-800 bg-panel shadow-md`; header `border-b border-neutral-800 px-5 py-4` with normal-case `text-sm font-medium` title + `text-xs text-neutral-500` description; footer `border-t border-neutral-800 px-5 py-4` right-aligned buttons. Cards INSIDE a dialog stay bg-neutral-900 (lighter than the dialog — correct Studio layering).
Dropdown/popover content (VERIFIED: bg-overlay #242424, border-overlay #333): `rounded-md border border-[#333333] bg-[#242424] p-1 shadow-lg`; items `rounded px-2.5 py-1.5 text-sm hover:bg-[#2e2e2e]`.

## Links
Inline links: `text-accent hover:underline` (green), optional 14px external-link icon.

## Toasts
Quiet dark (VERIFIED: Studio toast = bg-overlay): `rounded-md border border-[#333333] bg-[#242424] px-4 py-3 text-sm text-neutral-100 shadow-lg` with a green check icon — no colored ring/tint on the box itself.

## Never
- `rounded-full` on buttons (only badges/dots/avatars)
- `font-semibold`/`font-bold` on buttons or stat values (use `font-medium`)
- solid red delete buttons in tool UIs (bordered red-text instead)
- `text-white` on green (always near-black `#161616`)
- buttons taller than 32px outside auth/hero CTAs
- shadows heavier than `shadow-xs` on static cards
