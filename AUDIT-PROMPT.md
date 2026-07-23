# PASTE EVERYTHING BELOW THIS LINE INTO A NEW CHAT

ultracode +3000k

You are performing a **world-class, adversarial, full-system audit** of this codebase — the Miraside internal Meta-Ads dashboard (Next.js + Supabase + Vercel + Meta Marketing API + GoHighLevel + n8n). Your mission: find **real errors, race conditions, inconsistencies, things that will break under load or edge cases, and things that make no sense** — before they break in production. This app manages real ad spend and real leads for a live business; treat every finding as if money depends on it, because it does.

Do not summarize the app back to me. Do not give me a tour. I want **verified defects and concrete risks**, ranked by severity, each with file:line, a concrete failure scenario, and a suggested fix. Report findings only — **do not apply any fixes** in this session.

## Effort mandate — this is explicit authorization

- Use the **Workflow tool** aggressively: multi-phase, multi-agent orchestration for every stage. Fan out parallel reviewers per subsystem and per review dimension. Token cost is NOT a constraint; thoroughness is the only goal.
- Every candidate finding must survive **adversarial verification**: spawn 3 independent skeptic agents per finding, each prompted to REFUTE it by reading the actual code. Kill findings that ≥2 skeptics refute. Findings that survive get labeled CONFIRMED; uncertain ones PLAUSIBLE.
- Use **loop-until-dry**: keep launching fresh finder rounds (with different lenses) until 2 consecutive rounds surface nothing new. Do not stop at a fixed count.
- Finish with a **completeness critic** agent: "what subsystem, route, or failure mode has not been examined?" — and run one more round on whatever it names.
- Read files fully. No skimming. If a finding depends on how two files interact, read both before claiming anything.

## System map (ground truth — verify, then go deeper)

- **Stack:** Next.js 16 App Router (Turbopack), React 19, Tailwind v3, TypeScript. Supabase (project ref `sybpedxhmbalfzvntzcd`) — Postgres + Auth + Storage, RLS enabled, ~17 tables + settings. Deployed on Vercel (`vercel --prod` then MANUAL alias to miraside-dashboard.vercel.app). Auth gating via root `proxy.ts` (middleware) — check its public-path list.
- **Docs in repo (read all first):** `HANDOFF.md` (consolidated state), `DESIGN-SYSTEM.md` (UI source of truth), `SOURCE-TRACKING.md`, `GHL-SETUP.md`, `plan.md`, `PLAN-REVISIONS.md`. Auto-memory (MEMORY.md) is loaded in your context — trust it as orientation, verify against code.
- **Pages:** `/` Overview (KPIs, charts, funnel), `/leads` (CRM + Quality-by-ad), `/campaigns` (Ads Manager drill-down: Campaigns→Ad sets→Ads, edit/publish/duplicate at all levels), `/launch` (Ad Launcher + launch history), `/decision`, `/settings`, `/team`, `/login`, `/privacy`.
- **The batched launch pipeline (highest-risk subsystem — audit hardest):**
  `components/launcher/adsetup/AdSetup.tsx` → `POST /api/launches/create` → validates, writes `ad_launches` row (status LAUNCHING), responds immediately, then `after()` runs batch 1 via `lib/launch.ts` (`launchRowsFromPaths`) → queues remainder in `pending` JSONB → self-chaining `POST /api/launches/process` (shared secret header `x-launch-secret` = `SYNC_TRIGGER_SECRET`), `BATCH_SIZE=5`, `BATCH_INTERVAL_MS=180000`, `MAX_STALLS=8`, claim via `claim_next_launch_batch` RPC using `pending.lock`. Cancel via `/api/launches/[id]/cancel`. Statuses: DRAFT/LAUNCHING/PAUSED/PARTIAL/FAILED/CANCELLED. History thumbnails = data-URLs in `thumb_urls`. maxDuration 300.
  Audit for: double-claim races between chained processors; lock leakage if a processor dies mid-batch; cancel racing batch-1's `after()`; `pending` cleared without persisting rows (loses ad copy — happened once); storage cleanup deleting images that failed rows still need (a bug was fixed in process/route.ts, but the **batch-1 path in create/route.ts still cleans ALL batch-1 paths on partial failure and doesn't requeue batch-1 failures — known gap, assess severity**); stall-counter correctness; what happens if Vercel kills the function at exactly maxDuration; idempotency if `triggerProcess` fires twice; ETA/progress correctness in `LaunchProgressModal`.
- **Meta write layer (`lib/launch.ts`, `lib/meta-ads.ts`, `/api/ads/*`):** API v23.0, dev-tier rate limits (error code 17 / subcode 2446079). Locked preset: OUTCOME_LEADS, CBO €15, Advantage-audience OFF, age 29–65, FB+IG. CBO delivery-goal guard: landing-page (OFFSITE_CONVERSIONS) ad set cannot join an instant-form (LEAD_GENERATION) CBO campaign (Meta error 100/1885760) — verify the guard in `prepareNewAdSets` covers ABO vs CBO and `existingMode` correctly. Everything must launch PAUSED — verify NO code path can create ACTIVE objects. Creative edits are rebuild-and-swap — check for orphaned creatives/ads on partial failure. Duplicate flow: `/api/ads/duplicate` + `duplicate-load`.
- **Lead pipeline (real-time, live):** Meta leadgen webhook → `/api/webhooks/meta-leads` (verify: signature/verify-token validation, dedup on `meta_lead_id`, replay safety) → normalize (`lib/leads.ts`) → insert `leads` → GHL contact create/update (`lib/ghl.ts`; custom fields auto-created in ADS folder; write-once Lead/Conversion Source as "Channel—Detail") → n8n webhook → Slack. Separate: `/api/leads/website` (2-stage website-audit lead: started/completed, URL-param attribution `fb_ad_id`, channel "Paid Ads" vs "Direct", gated CAPI firing). Audit: webhook auth, idempotency, partial-failure handling (GHL down? n8n down?), attribution-join correctness in `lib/leads-data.ts` (leads joined to `ads` table for thumbnails), `qualification` gating (ONLY Meta CompleteRegistration is gated by `qualified` — GHL qualified/unqualified must NEVER gate CAPI).
- **Sync:** `/api/sync/facebook` + `scripts/sync-facebook.ts` (insights → `ads`/`ad_insights` tables). Check date-window logic, timezone (account is Europe/Lisbon? verify), EUR-native (no FX anywhere by decision), upsert dedup.
- **Auth/roles:** admin vs user; users can't change settings or manage team (must be enforced in BOTH UI and API — verify every mutating route checks role, not just the UI); admins can't be deleted; bootstrap admin = `ADMIN_EMAIL` env. Check `proxy.ts` public list, `/api/webhooks/meta-leads` + `/api/launches/process` (secret-based, not session), and every `/api/*` route's auth story one by one — build an **auth matrix** (route × method × who can call it × what tenant scoping).
- **Design system:** `DESIGN-SYSTEM.md` is law (Supabase Studio port, 2026-07-02, className-only restyle across ~50 files). Sweep for regressions the restyle could have introduced: `group-hover:` without a `group` parent, focus states lost, disabled states lost, contrast below 4.5:1 for body text, layout breakage from `h-7`/`h-[34px]` control heights in tight table cells, truncation of long campaign names, mobile (<md) sidebar behavior.

## Business rules / invariants to check the code against

1. Every Meta object is created PAUSED. No exceptions, no code path.
2. Ad status (ACTIVE/PAUSED) is never changed programmatically without an explicit user action on that specific object.
3. Single tenant / single ad account **by permanent user decision** — id-only lookups in manage/duplicate are accepted; do NOT flag multi-tenant scoping as a finding.
4. EUR only, no FX conversion anywhere.
5. `qualified` gates ONLY the Meta CompleteRegistration CAPI event.
6. Deploys must never happen while a launch is LAUNCHING (kills the in-flight processor); Meta reads during a launch eat the rate budget. (Audit whether the system itself defends against this, or only convention does — that gap is itself a legitimate finding.)
7. Vercel prod deploys don't auto-move the live alias (manual `vercel alias set` step) — check nothing assumes otherwise.

## Review dimensions (spawn dedicated finder agents per dimension)

1. **Concurrency & races:** the launch chain, webhook double-delivery, simultaneous edits, RPC atomicity (`claim_next_launch_batch` — read its SQL via Supabase MCP), optimistic UI vs server state.
2. **External-failure resilience:** for EACH external call (Meta, GHL, n8n/Slack, Supabase storage), what happens on timeout / 4xx / 5xx / rate-limit mid-flow? Orphaned state? Stuck LAUNCHING rows? Silent lead loss?
3. **Security:** route auth matrix; webhook verification; secret handling (`SYNC_TRIGGER_SECRET`, `META_SYSTEM_USER_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_API_KEY` — never logged/echoed/leaked to client?); RLS policies vs service-role usage; SSRF/injection in any URL/param passed onward; `dangerouslySetInnerHTML` in `Brand.tsx` (file-sourced SVG — is the source trusted-only?).
4. **Data integrity:** attribution joins (fb_ad_id, fbclid CAPI-only), lead dedup, insight upserts, timezone boundaries on date ranges, `text[]` vs jsonb handling (`thumb_urls`), nullability assumptions on Meta fields.
5. **Meta API correctness:** v23.0 param validity per endpoint, error-code handling (17/80004/100+1885760), pagination completeness, `execution_options:["validate_only"]` usage, token expiry behavior.
6. **React/client correctness:** React 19 + Next 16 pitfalls — `e.currentTarget` inside deferred state updaters (a past prod crash!), stale closures in polling hooks, missing cleanup in effects, `URL.createObjectURL` leaks in the launcher, race between modal open state and live-refreshing data, `after()` semantics assumptions.
7. **State-machine soundness:** enumerate every `ad_launches.status` transition actually reachable in code; find dead/unreachable/inconsistent transitions (e.g., can a CANCELLED launch resurrect? can PARTIAL show a spinner?).
8. **Config/deploy:** env var usage vs `.env` completeness, `maxDuration` vs real worst-case batch time, Turbopack-only parse issues tsc misses (`npm run build` is the real gate), `next/font` offline-build risk.
9. **DB schema:** via Supabase MCP (READ-ONLY): missing indexes on hot queries (leads by tenant+created_time, ad_insights joins), missing FK/unique constraints that code assumes, RLS advisor warnings (`get_advisors`).
10. **UX/logic coherence:** numbers that can disagree between Overview/Leads/Ads Manager for the same period (different sources: synced insights vs live webhook leads); copy that promises what code doesn't do; the Quality-by-ad Direct-vs-Paid split correctness.
11. **Design-system conformance + visual regressions** (per DESIGN-SYSTEM.md; className-only restyle audit as described above).
12. **Dead code / drift:** routes or components no longer reachable (classic /create was deleted — any dangling refs?), docs contradicting code, memory/HANDOFF claims that code no longer satisfies.

## Hard safety constraints for THIS audit session (absolute)

- **READ-ONLY everywhere.** No file edits except your final report. No git. No deploys. No dev-server restarts if a launch is running.
- **Zero Meta Marketing API calls.** Not even reads, not even validate_only — the account is on a dev-tier rate limit that real launches need. Audit Meta behavior from code + docs only.
- Supabase MCP: `execute_sql` with SELECT-only queries; `get_advisors`, `list_tables` fine. NO mutations, NO migrations.
- Never print secret values from `.env` — reference them by name only.
- Do not create/modify/toggle anything in GHL, n8n, or Slack.
- First action before anything heavy: `select count(*) from ad_launches where status = 'LAUNCHING'` — if > 0, note it and avoid anything that could disturb the machine (no builds either).

## Known issues — do NOT re-report these as findings

- Batch-1 cleanup gap in `create/route.ts` (described above) — instead, ASSESS its real-world severity and propose the minimal fix as a special section.
- Single-tenant id-only lookups (permanent decision).
- GHL revenue/ROAS not built yet; Leads-CRM per-ad attribution blocked on Meta `leads_retrieval` permission; SOURCE-TRACKING other-window wiring pending — these are known roadmap, not defects.
- `.next/types/* 2.d.ts` cloud-sync duplicate files breaking tsc — housekeeping, filter them.

## Method (run as sequential workflow phases; verify between phases)

- **Phase 0 — Map:** parallel readers build the real route/component/table inventory and the auth matrix. Cross-check against this prompt; where reality differs from what I've told you, flag the drift itself.
- **Phase 1 — Deep finders:** one agent per subsystem (launch pipeline, Meta write layer, lead pipeline, sync, auth/roles, Ads Manager UI, launcher UI, Overview/queries, schema) × one agent per review dimension above. Each returns structured findings.
- **Phase 2 — Adversarial verify:** 3 skeptics per finding as specified. Dedup across all rounds by (file, line-range, defect).
- **Phase 3 — Loop until dry** (2 consecutive empty rounds), then completeness critic, then one final round on its output.
- **Phase 4 — Report:** write `AUDIT-REPORT.md` in the project root: executive summary (top 10 by severity), then all CONFIRMED findings (severity, file:line, failure scenario, fix), then PLAUSIBLE ones, then the batch-1-gap assessment, then a "what I could not verify without live access" appendix. Also run `npx tsc --noEmit` (filter `.next/types`) and — ONLY if no launch is LAUNCHING and the dev server is stopped — `npm run build`, and include results.

Severity scale: **P0** = can lose money/leads or corrupt live campaign state; **P1** = will break under a realistic edge case; **P2** = inconsistency/latent bug; **P3** = polish/drift.

Begin with Phase 0 now. Take as long as it takes.
