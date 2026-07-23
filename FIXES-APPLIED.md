# Audit Fixes — Applied

Companion to `AUDIT-REPORT.md`. Every CONFIRMED/PLAUSIBLE finding was addressed. `npx tsc --noEmit` is clean (0 errors outside `.next/types`). **`npm run build` was NOT run** (dev server was live on :3000) — run it with the dev server stopped before deploying (Turbopack catches parse errors tsc misses). `ad_launches` LAUNCHING count was 0, so DB migrations were safe to apply.

## Database migrations applied (live, project `sybpedxhmbalfzvntzcd`)
- **C1** `secure_claim_next_launch_batch` — `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` (now `service_role` only) + clamp `lease_seconds` to [1,600]. Verified ACL = `{postgres, service_role}`.
- **C69** `fb_event_health_unique_nulls_not_distinct` — unique key recreated `NULLS NOT DISTINCT`.
- **C29/C33** `leads_add_ghl_pushed_at` — `leads.ghl_pushed_at timestamptz`.
- **C41** `hierarchy_soft_delete` — `deleted_at` on campaigns/adsets/ads (+ partial indexes).

## Code fixes by area

| Finding | Fix | File(s) |
|---|---|---|
| C1 | RPC callers unchanged (service-role only) | (DB) |
| C2 | opt-in origin allowlist (`WEBSITE_LEAD_ORIGINS`) + per-IP rate limit + don't-trust-`qualified` note | `app/api/leads/website/route.ts` |
| C3 | removed `NODE_ENV` auth bypass; gate dev on explicit `ALLOW_INSECURE_SYNC=1` | `app/api/sync/facebook/route.ts` |
| C4/C5 | `timingSafeEqual` for `x-launch-secret` and webhook verify-token | `app/api/launches/process/route.ts`, `app/api/webhooks/meta-leads/route.ts` |
| C7 | `isAdminUser` gate on presets POST/DELETE | `app/api/presets/route.ts` |
| C8/C10 | self-heal: sync route pokes `/process` + times out zombie LAUNCHING rows (via `launched_at`) | `app/api/sync/facebook/route.ts` |
| C9 | reclaim idempotency — skip creating an ad whose name already exists in the ad set | `lib/launch.ts` |
| C11 | requeued site-destination rows null `leadFormId` (match batch 1) | `app/api/launches/create/route.ts` |
| C12 | atomic draft claim `.eq("status","DRAFT")` + 409 on loss | `app/api/launches/create/route.ts` |
| C13 | cancel no-ops on non-LAUNCHING records | `app/api/launches/[id]/cancel/route.ts` |
| C14 | cancel-during-batch-1 → accurate PARTIAL + cleared draft; requeue/crash writes guarded on status | `create/route.ts`, `process/route.ts` |
| C15/C16 | requeue failed batch-1 rows; count actual creations; terminal PARTIAL on shortfall | `create/route.ts`, `process/route.ts` |
| C17 | cache the launcher's live Meta read (`unstable_cache`, 60s) so 4s polling doesn't burn rate budget | `app/(app)/launch/page.tsx` |
| C18 | cancel deletes the queued rows' orphaned images | `app/api/launches/[id]/cancel/route.ts` |
| C19 | `launched_at` now written on launch | `app/api/launches/create/route.ts` |
| C20 | dead statuses trimmed (ALLOWED_STATUS, STATUS_STYLE, type comment) | `launches/route.ts`, `LaunchHistory.tsx`, `types.ts` |
| C21/C64 | deleted the two orphaned direct-create routes (removes the buggy `createOneAdSet` path) | `app/api/ads/copy`, `app/api/ads/duplicate` (deleted) |
| C22 | abort on unreadable campaign (no silent ABO fallback); paginate the ad-set template read | `lib/launch.ts` |
| C23 | rebuild allows website ads; forwards description; deletes new-on-fail / old-on-success creative | `app/api/ads/manage/route.ts`, `lib/meta-ads.ts` |
| C24 | `archiveLeadForm` checks the API response (via `graphFetch`) | `lib/meta-ads.ts` |
| C25/C32 | page-token + lead-read calls now use the retrying `graphFetch` | `lib/meta.ts`, `lib/meta-ads.ts` |
| C26 | pixel/IG-actor caches only confirmed results (no null-poisoning) | `lib/meta.ts`, `lib/meta-ads.ts` |
| C27 | delete empty new ad sets left by a partial launch | `lib/launch.ts` |
| C28 | website lead row is INSERTed before the GHL write (GHL now best-effort) | `app/api/leads/website/route.ts` |
| C29/C33 | `ghl_pushed_at` gates the realtime push; webhook returns 503 on failure so Meta redelivers (retry) without duplicate Slack | `webhooks/meta-leads/route.ts`, `lib/sync/leads.ts` |
| C30 | log the "GHL not configured" skip | `lib/ghl-push.ts` |
| C31 | leads sync no longer resets qualification/GHL-link on a phone no-match (split matched/unmatched upserts) | `lib/sync/leads.ts` |
| C36 | warn when a paid click arrives without `event_id` | `app/api/leads/website/route.ts` |
| C37 | removed dead `fbclid` field | `app/api/leads/website/route.ts` |
| C39/N-leads | paginate dashboard insight selects + leads CRM select past the 1000-row cap | `lib/queries.ts`, `lib/leads-data.ts` |
| C40 | ROI engine reads effective settings (override → default) | `lib/queries.ts` |
| C41 | soft-delete (not cascade hard-delete) + proportional shrink guard; reads filter `deleted_at` | `lib/sync/facebook.ts`, `lib/queries.ts` |
| C42 | check `weekRes.error` | `lib/queries.ts` |
| C43 | validate/clamp `from`/`to` searchParams | `lib/queries.ts` |
| C45 | reach/frequency window respects the selected range (`window_end <= to`) | `lib/queries.ts` |
| C46 | clear stale in-range daily rows Meta no longer reports (guarded) | `lib/sync/facebook.ts` |
| C47 | anchor sync date math to a single `accountToday` | `lib/sync/facebook.ts` |
| C48/C49 | creative/row/dup ids are now `crypto.randomUUID()` (no cross-session collision) | `ImportZone.tsx`, `GroupingShared.tsx`, `AdSetup.tsx` |
| C50 | lead-form builder effect depends on `editId` only (stops wiping edits) | `LeadFormBuilderModal.tsx` |
| C51 | SettingsForm reverts optimistic change on save failure | `SettingsForm.tsx` |
| C52 | TeamManager `setRole`/`remove` catch network errors | `TeamManager.tsx` |
| C54 | PreviewModal effect keys on the fields it uses, not the whole row | `PreviewModal.tsx` |
| C57 | Toaster gained an error variant; error-path callers pass `"error"` | `Toaster.tsx` + ~10 callers |
| C58 | meaningful helper copy `neutral-600` → `neutral-500` (WCAG AA) | `ui.tsx` |
| C59 | stat value `font-semibold` → `font-medium` | `LaunchProgressModal.tsx` |
| C60 | truncate long campaign/ad-set names | `EditableName.tsx` |
| C61 | dropped dead `group-hover` classes | `AdLauncher.tsx` |
| C66 | "Create page" copy → "Ads Launcher" | `AdEditPanel.tsx` |
| N-team | `/team` redirects non-admins before the roster read | `app/(app)/team/page.tsx` |
| N-recommend | zero-lead over-gate ad now flagged "Investigate", not "Running normally" | `lib/recommend.ts` |
| N-decision | corrected the "Leave alone" column blurb | `app/(app)/decision/page.tsx` |
| N-meta-0 | drop platforms with no positions (coherent targeting) | `lib/launch.ts` |
| N-meta-2 | create POSTs no longer retried on ambiguous transient errors (rate-limit only) | `lib/meta.ts` |
| N-metaresok | 5xx/HTML Graph responses tagged transient so retry backs off | `lib/meta.ts` |
| N-carousel ×3 | block Continue while ungrouped; cap carousel at 10 cards; never emit 1-card carousels | `CarouselModal.tsx`, `GroupingShared.tsx`, `AdLauncher.tsx` |
| N-login | reject non-same-origin `?redirect` after login | `LoginForm.tsx` |
| N-leadform | de-dupe colliding lead-form field keys | `lib/leadform.ts` |

## Second pass — remaining deferred items now done
| Finding | Fix | File(s) |
|---|---|---|
| C34 | started/completed Slack race — poll up to ~3s (6×500ms) instead of a single 900ms wait | `app/api/leads/website/route.ts` |
| C35 | log when a GHL read failure skips first-touch (no longer silent) | `lib/ghl-write.ts` |
| C44 | Overview "Leads" KPI labeled "Meta-reported, this range" (distinct from the Leads page's all-time records) | `app/(app)/page.tsx` |
| C53 | only inject Meta's expected `<iframe>` preview — never arbitrary markup / `<script>` | `AdEditPanel.tsx`, `PreviewModal.tsx` |
| C56 | cooldown countdown anchored to the client clock (no server/client skew) | `LaunchProgressModal.tsx` |
| C68 | orphaned table reversibly retired → renamed `deprecated_lead_form_settings` | (DB migration) |

## Still NOT changed (deliberate — would risk correctness/prod, not "fillers")
- **C6 (CSRF/Origin check)** — NOT added. Behind Vercel's proxy the request `Host` and browser `Origin` legitimately differ, so a naive same-origin check would **403 every real mutation in production**, and there's no safe way to validate it without live testing. SameSite=Lax already blocks the actual cross-site threat (which is why the audit rated it P3). Adding a broken check would be far worse than the P3 it fixes.
- **C38 (same person → two lead rows)** — NOT merged. A website "audit started" and a later instant-form submission are genuinely distinct touchpoints; auto-collapsing them at the view layer risks **hiding a real lead**. Left as separate, correct records (matches the audit's own hesitation).

## New optional env vars (behavior unchanged if unset)
- `WEBSITE_LEAD_ORIGINS` — comma-separated allowlist for `/api/leads/website` CORS (defaults to `*`).
- `ALLOW_INSECURE_SYNC=1` — dev-only escape hatch for a secret-less `/api/sync/facebook`.

## Behavior changes to be aware of
- **Meta lead webhook:** `/api/webhooks/meta-leads` **ALWAYS returns 200** to Meta — it never bounces a failure back. Durability is instead handled internally: `captureLead` always stores the lead, and any lead whose GHL/n8n push fails is left with `ghl_pushed_at = NULL` so the scheduled sync (`runLeadsSync` → retry sweep) re-pushes it. Existing leads were backfilled as already-pushed, so the sweep only ever retries genuine post-deploy failures — no duplicate Slack.
- **Soft-delete:** archived/removed Meta objects are now hidden via `deleted_at` instead of being cascade-deleted; their insight history is preserved. Existing rows get `deleted_at = NULL` on the next sync.

## Build & deploy
- `npm run build` (Turbopack) — **passed** (compiled + TypeScript + 23 pages).
- Deployed: `vercel --prod` → `dpl_47ruhVs5PiAoKE6JyJ6uY61SiBBf` (READY, production).
- Alias moved: `miraside-dashboard.vercel.app` → the new deployment.
- Smoke test: `/privacy` 200, `/` 307→/login, `/login` 200, webhook bad-token 403. All green.
- Dev server restarted locally.
