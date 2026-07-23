# Leads Tab — Deep Audit & Improvement Plan (2026-07-20)

56 verified findings from a 63-agent audit (6 lenses: CRM workflow, Leads UX, Ad quality, Tasks queue, design fidelity, data/scale), each adversarially checked against the live screenshots and code. Nothing here is implemented — this is the plan.

## The three-sentence verdict

1. **The work queue is broken as a system**: a lead marked "No answer" leaves every queue forever (To-call excludes it, no task is created, Tasks shows "nothing left to do") — and the live data shows the damage: ~14 leads written off as Unqualified after a single dial.
2. **Ad quality can't answer its own question**: it has no spend, no CPL, no cost-per-qualified, hides ads that spend without producing leads, and ranks 100%-of-1 above 75%-of-4.
3. **The Leads table is a wall of ~50 tinted controls instead of a scannable list** — state should be read-only badges with actions behind hover/expansion, per the Supabase design language.

---

## P0 — Stop the bleeding: work-queue correctness (~1–2 days)

The queue logic is wrong today; these change behavior Miguel must sign off on:

1. **Retry black hole (CRITICAL, the headline finding).** "No answer" removes a lead from To-call (rule = `callState === "none"` only, `LeadsView.tsx:582/:616/:1136`) while the tooltip promises "never tried or no answer yet". No task is created (the nudge is gated on `qualified` and dismissible). Fix: queue rule becomes *"in play and nothing scheduled"* — include `no_answer`/`follow_up` leads with no open task and no upcoming appointment; apply the same rule to the amber rail so cue and queue never diverge; un-gate the nudge (fire on any no-answer for a lead not unqualified).
2. **"To call (5)" currently points at 5 already-qualified leads** (booking auto-qualify marks them qualified while callState stays none). Proposed rule: `callState none && qualification pending && no appointment`. Decision needed: this supersedes the earlier "untouched only" rail rule.
3. **"Follow up" is a silent exit**: no date required, no task created, no filter/count anywhere — only a violet badge you'd have to scan for. Fix: flipping to follow-up opens the existing date prompt and creates the GHL task (or blocks without a date).
4. **Tasks empty state lies** ("nothing left to do" while 5 leads are uncalled and 18 sit at no-answer). Fix: truthful copy + link to the pre-filtered Leads view, or fold "Never called" into the queue as a section.
5. **Sync last-write-wins revert (MAJOR)**: a tag write between the GHL snapshot (sync line ~135) and the upsert (~265) is silently reverted for a cycle and can double-count attempts. Fix: skip writing qualification/call_state when the row's stored ghl_tags already equal the snapshot's, or stamp local writes and compare times.
6. **Duplicate-person double-count**: two rows sharing a ghl_contact_id each get `qualified` written by the booking auto-qualify; KPIs and Ad-quality count per-row. Fix: badge + link duplicates, dedupe KPI/ad rollups by contact (first-touch ad).
7. **GHL appointment list flakiness — finish the fix**: replace the per-contact list read with a per-calendar events sweep (fewer calls, immune to the endpoint that silently returned `[]` on 2026-07-19); the by-id verify-before-clear guard already shipped.
8. **Feedback correctness**: successes never clear a prior error in the shared header note (it sits forever); errors appear far from the click. Fix: inline row-level error text or a proper toast (success auto-dismiss, error sticky). Task Delete currently has ZERO confirmation (tooltip only) — add confirm or 30s undo; lead delete gets undo too.
9. **Surface `last_call_attempt_at`** (recorded on every dial, never selected/rendered): "no answer · 2, tried 3d ago" next to the counter; order the retry queue oldest-attempt-first. Data already in the DB.

## P1 — Ad quality becomes decision-grade (~1 day)

10. **Spend, CPL, Cost/Qualified columns** from fb_insights_daily (join note: insights key by internal ad id — map via ads table). Cost-per-qualified is *the* kill/scale number. "Cheapest qualified" sort.
11. **Zero-lead ads with spend must appear** (they're the worst ads and are invisible here today; seed rows from the ads table, "—" rate, filter never-delivered).
12. **Sample-size guards**: show denominators ("2/3 decided"), require ≥3 decided for Best/Worst ranking, sink/grey tiny samples.
13. **Time window toggle (30d / 90d / All) + "Last lead" column** (lastLeadAt already computed, never shown).
14. **Active/paused status dot + "Active only" filter**, each row deep-links to Ads Manager (link, never auto-act).
15. **Group by Ad set toggle** = the text-vs-design / angle comparison (ad set = angle×type under the folder-launch structure; fb_adset_id already stored on every lead — read-path only).
16. **Row click → Leads view pre-filtered to that ad** (~3 lines; also the practical fix for the numeric-named ads) + a muted second line (ad set · launch date) and hover creative preview.
17. **Stop painting zeros green/red** — tone only non-zero values.

## P2 — Tasks becomes THE work queue (~1 day)

18. **Queue-native columns** in Tasks view: Task · Due · Lead · Phone · Call (drop Ad/Submitted); Overdue / Today / Later chips instead of qualification tabs.
19. **Inline Done + snooze on queue rows** (no expansion needed); "+1 day / Monday / pick date" reschedule via GHL task update (PUT endpoint exists; today reschedule = delete + recreate).
20. **Persistent create affordance**: dismissed nudge leaves a small clock button on the row; "+ Add task" reachable without expanding.
21. **Multi-task honesty**: mirror the open-task count ("+1 more") — today only the earliest open task exists on the dashboard.
22. **Self-populating option** (decision): auto "First call" task on new matched leads, or the "Never called" section from P0.4.

## P3 — Missing CRM primitives (~2 days)

23. **Notes / call log** — the single biggest missing primitive. Free-text note per lead written to GHL contact notes (same source-of-truth pattern), shown in the expanded panel; target state: note attached per call attempt.
24. **Who-did-what + owner**: stamp actor/timestamp on state changes (jsonb activity column; GHL can't provide this — one shared API token), "set by X, 2d ago" in the panel; optional assignee to split the queue between callers.
25. **No-show recovery**: past appointment without `showed` → actionable again (rose chip, "No-shows" filter); showed/no-show tally per ad feeds Ad quality.
26. **Click-to-copy phone (leads), tel: and wa.me links** — copy is the load-bearing one on desktop; WhatsApp matters for PT B2B follow-up.
27. **Search includes email** (3 lines); **bulk set state/qualification + CSV export of current filter**; duplicate badge from P0.6.

## P4 — Design-system unification (~1 day)

28. **Row de-clutter**: state as read-only Studio badges; controls appear on hover/expanded/drawer; one tinted element per row so the amber rail pops again. Qualification = ONE badge when decided (carrying the meeting stamp: "Qualified · 21 Jul 10:00"), two buttons only while pending; kills the mis-click risk of the permanent double button.
29. **Color vocabulary**: amber = "needs action now" ONLY (recolor No-answer trigger to neutral+dot, STARTED→neutral/sky); violet double-duty (follow-up vs meeting) resolved; add violet to DESIGN-SYSTEM.md or drop it.
30. **One badge formula** (/30 border, /10 bg, 300 text; rounded-full status vs rounded-md controls); **overlay recipe** (#242424/#333/shadow-lg) applied to CallSelect menu + FloatingPrompt; CallSelect trigger inherits AppSelect details.
31. **Two control heights only** (34px toolbar / 28px in-row; delete the h-6 variant); status tabs get the boxed p-0.5 segmented container like the view toggle.
32. **Expanded panel typography**: PT form questions are content, not labels — sentence-case text-xs neutral-400 (not 11px ALL-CAPS); two-level hierarchy (sections vs fields).
33. **KPI band earns its space**: To call (clickable), Qualified rate (of decided), Leads this week vs last, Next meeting — or delete the band (today it duplicates the filter tabs).
34. Polish set: attempts cluster (stroke icons, one disabled recipe, hide at 0), open-row selected state (highlight class is a no-op today), action-cluster consistency (no hardcoded hex, one link hue, real button for the expander/keyboard focus), column width rebalance (AD gets the space Qualification wastes), empty Tasks view suppresses dead toolbar.

## P5 — Scale & state (~1 day)

35. **Reconcile from PATCH responses instead of router.refresh()** (response already carries the state); first ~100 rows + "Load more"; `.order` tiebreaker in fetchLeadViews; step-3b skips unchanged contacts (compare stored ids first) to keep sync fast at 1k leads.
36. **URL-persisted filters** (status/ad/tocall/q) so refresh/back keep the working set; "showing N of M" beside the table.
37. **Staleness caption on the table** ("GHL state as of HH:MM · Refresh") + reconcile the two Refresh buttons (sidebar one is a superset); router.refresh on window focus.
38. Default view lands on the worklist when To-call > 0 (or actionable-first ordering).

## Known data cleanup (no build)
- Rename the legacy numeric ads "1"–"5" in Meta (safe metadata edit) — or rely on P1.16's secondary identity.

## Suggested sequence
P0 → P1 → P2 (behavioral core, ~3-4 days) → P4 (one visual pass over the stabilized layout) → P3 (primitives, can interleave) → P5. Full raw findings (56, with file:line evidence and verifier refinements): `~/.claude/.../tool-results/b45gorjnx.txt` + workflow journal `wf_45d43f91-b59`.
