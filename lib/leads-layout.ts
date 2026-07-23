/**
 * Column widths (px) for the Leads CRM table — the SINGLE source of truth shared by the page
 * container's max-width and the table's <colgroup>. They must never drift apart: if the page can
 * grow wider than the table's ideal width, the one flexible column (Lead / names) absorbs the
 * surplus and balloons on wide screens, and narrow fixed columns overflow into their neighbours
 * (the Submitted timestamp spilling over the Call dropdown). Capping the whole content at the
 * table's ideal width keeps every screen size correct.
 */
export const LEADS_COLS = {
  checkbox: 40,
  leadMin: 280, // floor on narrow screens — the table scrolls horizontally below this
  leadMax: 340, // cap on wide screens — stops the name column ballooning into empty space
  company: 190, // fits the real extracted names ("All Finance Matters", "Gráfica Lousanense") without ballooning; rare longer ones truncate with a tooltip
  // Sized from a MEASURED width, not an estimate: "+351968598134" renders at 118px in Inter at 14px
  // tabular-nums (the app's actual face — assuming a system stack under-counted it by 16px).
  // Budget = 118 (number) + 8 (gap) + 68 (dial + WhatsApp + template picker: 3 × 20 + 2 × 4) +
  // 32 (px-4) = 226, rounded up for slack. All THREE buttons are counted because the dial one is
  // md:hidden — a fixed column width does not change with the viewport, so the NARROW case is what
  // the column must satisfy. The buttons sit in the flow rather than floating over the number; this
  // width is what keeps them from squeezing it at any screen size.
  phone: 240,
  ad: 156,
  submitted: 132, // fits "Jul 20, 08:56" (24h) without spilling into Call
  call: 356, // fits the dropdown (148px — "Meeting booked" fully visible) + clock button + the [count · recency | − | +] pill
  qual: 196,
  meeting: 160, // booked-call chip "21 Jul · 10:30" — its own column so it can't overlap Actions
  actions: 268,
  actionsAudit: 336, // wider when any lead carries an audit link
  pagePadX: 48, // the page container's px-6 on both sides
} as const;

/** Sum of every fixed (non-Lead) column. */
export function leadsFixedWidth(hasAudit: boolean): number {
  const c = LEADS_COLS;
  return c.checkbox + c.company + c.phone + c.ad + c.submitted + c.call + c.qual + c.meeting + (hasAudit ? c.actionsAudit : c.actions);
}

/** Table floor: below this the table scrolls horizontally instead of crushing columns. */
export const leadsTableMinWidth = (hasAudit: boolean) => leadsFixedWidth(hasAudit) + LEADS_COLS.leadMin;

/** Page content cap: the table's ideal width (Lead at its max) plus the container padding. */
export const leadsContentMaxWidth = (hasAudit: boolean) => leadsFixedWidth(hasAudit) + LEADS_COLS.leadMax + LEADS_COLS.pagePadX;
