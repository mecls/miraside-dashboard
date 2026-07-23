# Miraside Meta-Ads Dashboard — Adversarial Full-System Audit

**Date:** 2026-07-02  **Scope:** entire repo (Next.js 16 / React 19 / Supabase / Vercel / Meta Marketing API v23.0 / GoHighLevel / n8n) + live Supabase schema (project `sybpedxhmbalfzvntzcd`, read-only)
**Mode:** READ-ONLY. Zero Meta API calls. No file edits (except this report). No builds/deploys. No GHL/n8n/Slack mutations.

**Pre-flight:** `select count(*) from ad_launches where status='LAUNCHING'` → **0** (safe to audit). Dev server WAS running (PID 45954 on :3000) → `npm run build` deliberately **not** run. `npx tsc --noEmit` (filtering `.next/types`) → **0 errors** (see §Build/typecheck).

**Method:** 4 phases of multi-agent orchestration. Phase 0: 8 parallel subsystem/auth/schema mappers. Phase 1: auth-matrix + 5 fresh-lens finders. **Phase 2: 128 refute-mandated skeptic agents** (3 per P0/P1 candidate, 2 per P2, 1 per P3) — a finding was killed if ≥2 skeptics refuted it. Phase 3: completeness critic + 3 gap-finders on under-examined surfaces, then a second verification pass on new findings. **67 candidates → 74 CONFIRMED, 4 PLAUSIBLE, 3 KILLED.** Severities below are the skeptics' post-verification calibration, which downgraded some candidates (C7, C44→P3) and upgraded others (C16, C49→P1).

Severity scale: **P0** = can lose money/leads or corrupt live campaign state · **P1** = will break under a realistic edge case · **P2** = inconsistency/latent bug · **P3** = polish/drift.

> No finding was rated P0 after verification. C1 is P1 bordering P0 (unauthenticated RLS-bypass exfiltration + launch-queue DoS, but bounded to the active-launch window and recoverable via Cancel).

---

## Executive summary — top findings by severity/impact

| # | ID | Sev | One-line | File |
|---|----|-----|----------|------|
| 1 | C1 | **P1** (→P0) | Unauthenticated anon `claim_next_launch_batch` RPC exfiltrates in-flight launch payloads and can freeze the launch queue for ~68 years | DB fn + `app/api/launches/process/route.ts` |
| 2 | C28 | **P1** | Website lead is **lost entirely** when GHL is down — GHL write runs before the DB insert, so a GHL failure 500s and no lead row is written | `app/api/leads/website/route.ts:137,163` |
| 3 | C9 | **P1** | Processor hard-kill after Meta creations but before requeue → 260s lock expires, a later trigger replays the same rows → **duplicate paused ads on Meta** | `app/api/launches/process/route.ts` |
| 4 | C11 | **P1** | In a batched landing-page launch, ads after batch 1 keep `leadFormId` → built as instant-form ads (wrong type, **no `ad_id` attribution**, landing URL discarded) → Meta-rejected → PARTIAL | `create/route.ts:145-150`, `lib/launch.ts` |
| 5 | C48 | **P1** | Resuming a draft then "Add Ads" mints a colliding creative id → `byId` map keeps the new file → **the wrong image is launched to Meta**, original silently dropped | `ImportZone.tsx`, `AdLauncher.tsx:340` |
| 6 | C2 | **P1** | `/api/leads/website` is CORS `*` with a browser-embedded static token → attacker can fire **CAPI CompleteRegistration** (poisons ad optimization/spend), mint unbounded GHL fields + paid Anthropic calls | `app/api/leads/website/route.ts:194` |
| 7 | C40 | **P1** | Admin Settings overrides (target CPL, spend gate, window, thresholds) are **silently ignored** by Overview/Ads Manager — the ROI engine reads defaults only | `lib/queries.ts:180` |
| 8 | C29 | **P1** | A realtime lead that fails the GHL/n8n push after DB capture **never reaches GHL/Slack and nothing retries it** | `webhooks/meta-leads/route.ts`, `lib/ghl-push.ts` |
| 9 | C8 / C10 | **P1** | Launches get stuck in `LAUNCHING` forever: (C8) function killed after status set but before pending write; (C10) fire-and-forget self-chain dies mid-deploy — **no cron/sweeper recovers either** | `create/route.ts`, `lib/launch-batch.ts` |
| 10 | C41 | **P1** (plausible) | `reconcileDeleted` hard-deletes any ad absent from the Meta list and **cascade-deletes its `fb_insights_daily` history**; archiving an ad in Ads Manager (which Meta excludes from the default list) permanently destroys that ad's spend/lead history | `lib/sync/facebook.ts:55-64` |

Also P1: **C12** double-launch of one draft creates duplicate campaigns; **C16** processor counts ads by name-match not creation → drops un-launched rows / overcounts; **C17** the launch-progress UI polls Meta reads every 4s during a launch, self-inflicting the code-17 rate limit; **C49** duplicate row ids after draft resume → cross-row edit bleed.

Standout P2s worth reading first: **N-completeness-critic-0** (the `/team` page leaks every user's email + role + join date to any authenticated non-admin), **C24** (`archiveLeadForm` reports success even when it failed), **C31** (a routine leads sync resets a qualified lead back to "pending" and drops the GHL link when a phone doesn't match), **C13/C14** (cancel has no state guard and can flip a finished launch to PARTIAL).

---

## CONFIRMED findings — P1

### C1 — Unauthenticated `claim_next_launch_batch` RPC: payload exfiltration + launch-queue freeze  ·  `db:public.claim_next_launch_batch` / `app/api/launches/process/route.ts:16-21`
**Verified 3/3 skeptics (with live SQL).** `public.claim_next_launch_batch(lease_seconds int DEFAULT 260)` is `SECURITY DEFINER`, owner `postgres` (BYPASSRLS), `RETURNS SETOF ad_launches`, and its ACL grants `EXECUTE` to `anon`, `authenticated`, and `PUBLIC` (`proacl = {=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}`). The Supabase URL + `anon` key ship in the browser bundle (`lib/supabase/client.ts`). So any unauthenticated caller can `POST /rest/v1/rpc/claim_next_launch_batch` with `{"lease_seconds": 2000000000}`.
**Failure scenario:** during any in-flight batched launch (`status='LAUNCHING'`, `pending` set): (a) the call **returns the full oldest LAUNCHING row** — the `pending` JSONB (ad copy, `imagePaths`, `lead_gen_form_id`), `draft_state`, `thumb_urls`, `name`, `tenant_id` — to the anonymous caller, bypassing RLS; and (b) it stamps `pending.lock = now() + lease_seconds` up to ~68 years out. The worker's claim filter is `(pending->>'lock')::timestamptz < now()`, so a far-future lock is never reclaimed; the route's catch only clears a lock *it* set. There is no reaper. → remaining ads never publish; only manual Cancel exits. The `x-launch-secret` gate on `/process` is irrelevant because the RPC is reachable directly at PostgREST.
**Fix:** `REVOKE EXECUTE ON FUNCTION public.claim_next_launch_batch(int) FROM anon, authenticated, PUBLIC;` (the service-role admin client on `/process` retains it as owner). Additionally clamp `lease_seconds := least(greatest(lease_seconds,1),600)` inside the function and add a reaper that reclaims LAUNCHING rows whose lock is implausibly far in the future.

### C28 — Website lead lost entirely when GHL is down  ·  `app/api/leads/website/route.ts:137` (before) `:163`
**Verified 3/3.** `writeContactWithSource(...)` (line 137) runs **before** the `leads` claim insert (line 163). Any non-transient GHL failure (or exhausted `withGhlRetry`) throws; the catch at line 214 returns 500 and **no `leads` row is written** — the lead exists in no system unless the browser retries. The instant-form webhook path has the safer order (DB first, GHL second).
**Fix:** insert the `leads` claim row first (with `ghl_contact_id` null), then attempt the GHL write and patch `ghl_contact_id` on success; never let a GHL failure prevent lead persistence.

### C9 — Processor hard-kill → duplicate paused ads on Meta  ·  `app/api/launches/process/route.ts` + RPC
**Verified 3/3.** `process` claims the job (RPC leases `lock = now()+260s`), sleeps up to 250s, creates up to 5 ads (`createAd` is an unconditional `POST {act}/ads`), then requeues `pending` removing launched rows. If the function is hard-killed after Meta creation but before the requeue write (line 73-76), the catch-block lock release never runs; the 260s lease expires and a later `triggerProcess` reclaims the **same** `pending.rows` (still containing the created rows) → the same ads are created again. The `createdNames` dedup Set is in-memory and only spans one batch result, not reclaims.
**Fix:** make creation idempotent across reclaims — persist each created ad's Meta id / a per-row `created` flag into `pending.rows` *as each ad is created* (before the next), so a reclaim skips already-created rows; or query the target ad set for an ad of the same name before creating. Shortening the lease does not close the window.

### C11 — Batched landing-page launch: ads after batch 1 built as wrong ad type, lose attribution  ·  `app/api/launches/create/route.ts:145-150` / `lib/launch.ts:504,735`
**Verified 3/3.** The client sends `leadFormId: r.leadFormId` unconditionally (`AdSetup.tsx:498`). Batch 1 runs `prepareNewAdSets`, whose site branch forces `leadFormId: null` (`lib/launch.ts:504`) → correct website creatives with `url_tags` (`ad_id/adset_id/campaign_id`) into an `OFFSITE_CONVERSIONS/WEBSITE` ad set. But the requeued `rest` rows (`create:145-150`) set only `link`/`afterSubmitUrl` and **omit `leadFormId: null`**. In existing-ad-set mode `launchAds` sees a truthy `leadFormId` → builds an `ON_AD` instant-form creative with **no `url_tags`** and `link = defaultWebsiteUrl` (`lib/launch.ts:735-736`), discarding the landing URL.
**Failure scenario:** a >5-ad, single site-audience launch where rows carry a lead form (e.g. reopened/duplicated form launch): batch 1 = correct website ads; batches 2+ = instant-form ads dropped into a website ad set → **likely Meta-rejected → PARTIAL**, and any that land carry **zero click attribution** (landing page can never read `fb_ad_id`, defeating the entire SOURCE-TRACKING design).
**Fix:** build `rest` with the same site normalization as `prepareNewAdSets` — for the site branch set `leadFormId: null` and use the landing URL as `link`. Best: route requeued rows through the same destination-resolution logic so batch 1 and later batches cannot diverge. **Verify the UI does not already prevent `site`+`leadFormId`** on one row (skeptics confirmed it does not null it).

### C48 — Wrong creative launched to Meta after resuming a draft  ·  `components/launcher/ImportZone.tsx:11` / `AdLauncher.tsx:340` / `AdSetup.tsx:279`
**Verified (1 CONFIRMED, 0 refutes; 2 skeptics errored on schema).** `ImportZone` mints creative ids from a module-level `let uid = 0` (`c1, c2, …`). `resumeDraft` rebuilds creatives with their **persisted** ids (`{ id: m.id }`, `AdLauncher.tsx:340`) without advancing `uid`. Clicking "+ Add Ads" calls `filesToCreatives` → `c${++uid}` = `c1`, colliding with the restored first creative. In AdSetup, `byId = new Map(creatives.map(c => [c.id, c]))` keeps the **last** `c1` (the just-added file). At launch every creative resolves via `byId.get(id)`, so the original draft row referencing `c1` uploads the **new** image to Meta and the original is silently dropped — the wrong creative is attached to a real ad.
**Fix:** mint creative ids with `crypto.randomUUID()`, or re-seed `uid` past the max restored numeric id on `resumeDraft`, or reject/reassign an id already present in `creatives`. Fix together with C49 (same root cause).

### C2 — Public `/api/leads/website` enables CAPI poisoning + unbounded cost  ·  `app/api/leads/website/route.ts:17,86,194`
**Verified 3/3.** `Access-Control-Allow-Origin: *` + a static `x-lead-token` mean the token lives in landing-page browser JS and is effectively public. `body.qualified`, `ad_id`, `event_id`, `email`, `phone`, `client_ip`, `client_user_agent` are all attacker-controlled, with no rate limiting.
**Failure scenario:** an attacker who reads the token can (a) fire Meta **CAPI `CompleteRegistration`** (`route.ts:194` gates on `body.qualified`) with fabricated conversions → **pollutes ad optimization and can misdirect real spend**; (b) send `stage:completed` with up to 30 attacker-chosen `question` strings → each calls `ensureField` (**mints a permanent GHL custom field**, exhausting GHL's field cap and silently breaking the real CRM) and `ensureShortLabel` (**a paid Anthropic call**) → unbounded cost; (c) inject fake leads + Slack spam.
**Fix:** treat the endpoint as untrusted — restrict CORS to the landing-page origin(s), add per-IP/token rate limiting *before* `ensureField`/`ensureShortLabel`, allowlist known question keys, and do not trust `body.qualified` for a real-spend CAPI event without server-side corroboration. Ideally proxy the call through the landing page's own backend so the token is never browser-exposed.

### C40 — Admin Settings overrides silently ignored by the ROI engine  ·  `lib/queries.ts:180`
**Verified 3/3.** `getDashboard` loads settings via `sb.from("setting_definitions").select("key,default_value")` only — it never joins `tenant_settings`/`effective_settings`. Overrides are merged only in `lib/settings.ts` (launcher URL settings) and `lib/settings-editor.ts` (the Settings page's own display). `lib/settings.ts`'s own docstring admits: *"lib/queries.ts reads only defaults for the ROI engine."*
**Failure scenario:** an admin changes `target_cpl_eur`, `d12_spend_gate_multiple`, `reporting_window_days`, `small_sample_min_results`, or any flag threshold. The Settings page shows it as active, but **Overview, Ads Manager, the CPL gate, the flags, and the default date range keep using the definition defaults** — the override is a no-op everywhere it matters. (`tenant_settings` is currently empty, so this is dormant until the first override is saved.)
**Fix:** have `getDashboard` resolve effective values (override→default), reusing the `getSettingValues` merge from `lib/settings.ts`. If defaults-only is intended, make those keys read-only in `SettingsForm` so admins can't create ignored overrides.

### C29 — No durable replay for failed GHL/n8n pushes → silent lead loss to the CRM  ·  `webhooks/meta-leads/route.ts:88` / `lib/ghl-push.ts` / `lib/sync/leads.ts`
**Verified 3/3.** If `pushLeadToGhl` fails after `captureLead` (n8n down, GHL 4xx), the lead is in the DB but **never reaches GHL/Slack**, and nothing retries it — `runLeadsSync` only *reads* GHL for qualification, never re-pushes. The webhook always `return NextResponse.json({ ok:true })` (line 100). The only signal is a `reportError` Slack alert, itself silently dropped if `N8N_ERROR_WEBHOOK_URL` is unset.
**Fix:** persist a push outcome (`ghl_pushed_at`/`push_failed`) on the lead and add a replay job (or extend `runLeadsSync`) to re-push rows where capture succeeded but the push failed. Gate the n8n→Slack step on replay (it is not idempotent) to avoid duplicate notifications.

### C8 — Zombie `LAUNCHING` rows with no recovery path  ·  `app/api/launches/create/route.ts` / `process/route.ts`
**Verified 3/3.** `create` marks the record `LAUNCHING` then works in `after()`. If the function is killed (deploy, 300s timeout) after `LAUNCHING` is set but before a terminal update or `pending` write, the row is stuck `LAUNCHING` with `pending = null`. The claim RPC requires `pending is not null`, there is **no vercel.json cron, no sweeper, and no read-path reconciler**, and the UI polls forever. Non-batchable launches run *all* rows inside one 300s window, so large launches are the likeliest to hit this. Only manual Cancel exits.
**Fix:** add a recovery path — a cron/sweeper (or a reconciler on the history GET) that flips over-age `LAUNCHING` rows to `PARTIAL/FAILED`, and/or force large launches down the batched (pending-backed) path so a kill always leaves a claimable queue.

### C10 — `triggerProcess` is fire-and-forget to a hardcoded URL; broken chain strands the launch  ·  `lib/launch-batch.ts:23-33`
**Verified 3/3.** `triggerProcess` POSTs to `LAUNCH_BASE_URL || "https://miraside-dashboard.vercel.app"/api/launches/process`, 3 tries 1s apart, swallowing all failures. There is no cron and no other caller. If the alias is unreachable at that moment (mid-deploy — the alias must be manually re-pointed after every deploy per `deploy-alias-gotcha`), the self-chain dies: `pending` sits with `nextAt` in the past, `status` `LAUNCHING`, and nothing re-triggers.
**Fix:** the DB half is already resilient (lease expiry + oldest-pending pickup); it just needs a durable poke. The existing n8n Schedule Trigger that hits `/api/sync/facebook` can also POST `/api/launches/process` with `x-launch-secret` every few minutes — the claim RPC already lease-guards concurrency, so a periodic poke drains any stalled queue and makes the chain self-healing.

### C12 — Double-launch of one draft creates duplicate campaigns  ·  `app/api/launches/create/route.ts:106-112`
**Verified 3/3.** The draft claim `.update({status:"LAUNCHING"}).eq("id", draftId)...` has **no prior-status/version predicate**. Two tabs (or a double-submit) with the same `draftId` both get a `recordId` and both run full `after()` jobs concurrently → two campaigns/ad sets on Meta, interleaved `ad_count`/`pending` writes clobbering one row, and the second job's `pending` can resurrect a queue the first finished. (No DB triggers exist on `ad_launches`.)
**Fix:** make the claim atomic — add `.eq("status","DRAFT")`; if `draftId` was provided but the guarded update matched zero rows, return 409 instead of falling through to the insert (the loser would otherwise insert a *new* record and still run a duplicate `after()`). Consider an idempotency key for the fresh-launch path too.

### C16 — Processor counts ads by name-match, not creation → drops un-launched rows, overcounts  ·  `app/api/launches/process/route.ts:48-56`
**Verified 2/2 (severity upgraded P2→P1).** After a batch, `createdNames = new Set(result.created.map(c => c.name))`, `remaining = rows.filter(r => !createdNames.has(r.name))`, and `adCount += rows.length - remaining.length`. Ad names can duplicate across rows (`BulkEdit.tsx:140` sets a literal name for all selected). So two rows sharing a name are both removed when only one launched — **a never-launched row is silently dropped from the queue** and `ad_count` is overcounted (reported as success).
**Fix:** track launched rows by a stable per-row id (thread a `rowId` through `pending.rows` and `LaunchResult.created`), remove by id, and set `adCount += result.created.length`.

### C17 — Launch-progress polling self-inflicts the Meta rate limit  ·  `components/launcher/LaunchHistory.tsx:63` / `app/(app)/launch/page.tsx:37`
**Verified 2/3 (1 skeptic errored).** While any launch is `LAUNCHING`, `LaunchHistory` runs `setInterval(() => router.refresh(), 4000)`. Each refresh re-executes the `force-dynamic` `/launch` server component, which calls `listCampaignsWithAdSets()` — 2 paginated live Graph reads — with no caching. A long launch → thousands of Meta GETs from polling alone, competing with the processor's paced writes and tripping **code 17** (the exact hazard in `batched-launch-hazards`). Errors are swallowed to `[]`, so the ad-set tree silently empties under throttling.
**Fix:** poll a lightweight JSON status endpoint instead of `router.refresh()`, and/or wrap `listCampaignsWithAdSets` in `unstable_cache` (short revalidate) or fetch it lazily only when the "add to existing ad set" picker opens, so a progress refresh never triggers Graph GETs.

### C49 — Duplicate AdRow ids after draft resume → cross-row edit bleed  ·  `components/launcher/GroupingShared.tsx:9-10` / `AdSetup.tsx:35` / `AdLauncher.tsx:349`
**Verified 2/2 (severity upgraded P2→P1).** `idSeq`/`dupSeq` are module-level counters reset per page load and never re-seeded. `resumeDraft` restores rows with persisted ids (`grp_1`, `dup_1`) without advancing them; "+ Add Ads"/"Duplicate" then mint `grp_1`/`dup_1` colliding with restored ids. Because every row mutation is keyed by id (`patch`, `toggleSel`, `deleteSelected`), editing/selecting/deleting the new row also mutates the collided restored row, and React renders duplicate keys → unstable reconciliation.
**Fix:** mint row ids with `crypto.randomUUID()` (fix with C48), or re-seed both counters past the max restored suffix on resume.

### C41 — `reconcileDeleted` cascade-deletes insight history for archived ads  ·  `lib/sync/facebook.ts:55-64,263-268`  ·  **PLAUSIBLE → confirmed with corrected trigger**
**Verified split (1 CONFIRMED P1, 1 UNCERTAIN, 1 REFUTED-the-original-trigger).** `reconcileDeleted` hard-deletes every stored campaign/adset/ad whose fb id is absent from the current Meta list, guarded **only** by `if (!liveIds.length) return 0`. The FK is `ON DELETE CASCADE` (verified live: `fb_insights_daily_ad_id_fkey.on_delete='c'`), so deleting an ad **destroys all its `fb_insights_daily` history**.
The original "throttle causes a partial list" trigger was correctly **refuted** — `metaGetAll` throws on `json.error`, so reconcile only runs after a fully-successful pull. But the **real** trigger is worse because it is a *normal operation*: the list calls (`/campaigns`, `/adsets`, `/ads`, verified at `facebook.ts:193/213/235`) pass **no `effective_status`/`filtering`**, and Meta's account edges **exclude ARCHIVED objects by default**. So **archiving an ad/adset/campaign in Ads Manager makes the next 30-min sync hard-delete its local row and cascade-delete all its spend/lead history** — the rolling resync only restores ~14 days; older history is unrecoverable. (Paused objects *are* returned by default, which is why the app works day-to-day.)
**Fix:** never treat "absent from a default list" as "deleted" — either request archived/deleted explicitly (`effective_status`) before reconciling, guard against implausible shrinkage (skip/alert if live count < X% of stored), and/or soft-delete instead of FK-cascade so history survives.

---

## CONFIRMED findings — P2

### C3 — `/api/sync/facebook` auth bypassed when `NODE_ENV !== 'production'`  ·  `app/api/sync/facebook/route.ts:28`
**Verified 2/2.** `authorized()` returns `true` unconditionally when `NODE_ENV !== "production"`. Vercel prod+preview and `next start` all set `NODE_ENV=production`, so no actually-serving host is exploitable today — but any dev/self-hosted/Docker box carrying real service-role/Meta/GHL creds exposes an unauthenticated full Meta+GHL sync. The docstring's claim that auth "mirrors /api/settings" is also inaccurate (settings uses session-cookie admin auth). **Fix:** always require the secret when `SYNC_TRIGGER_SECRET` is set; gate any dev escape hatch on an explicit `ALLOW_INSECURE_SYNC` flag, not `NODE_ENV`.

### N-completeness-critic-0 — `/team` page leaks the entire user roster to any non-admin  ·  `app/(app)/team/page.tsx:16`  *(reclassified P2)*
**Verified 2/2 (one skeptic P2, one P3 — treated as P2: broken access control + PII).** The `/team` server component calls `admin.auth.admin.listUsers({perPage:200})` with the service-role client **unconditionally**; `isAdminUser(me)` only controls whether *management buttons* render (`canManage`). `proxy.ts` gates pages on session existence only, and the `/team` nav link shows for everyone. So any authenticated non-admin who visits `/team` sees **every user's email, admin status, and join date**. **Fix:** `if (!isAdminUser(me)) redirect('/')` (or render an access-denied panel and skip `listUsers`) before the roster read; hide the nav item for non-admins.

### C13 — Cancel has no state precondition — flips a finished launch to PARTIAL  ·  `app/api/launches/[id]/cancel/route.ts:41-43`
**Verified 2/2.** `cancel` sets `pending=null` and picks a resting status by `ad_count`/`draft_state` with **no check that the record is currently LAUNCHING**. POSTing cancel on a finished `PAUSED` launch (`ad_count>0`) flips it to `PARTIAL` with `"Launch cancelled — N ads already created"`, misrepresenting a completed success. **Fix:** only mutate when `status === "LAUNCHING"` (equivalently, no-op when `pending` is null, since a finished runner already cleared it).

### C14 — Cancel-during-batch-1 race writes `ad_count` onto the cancelled record  ·  `create/route.ts:152-156`
**Verified 2/2.** `create` re-checks cancellation only *after* batch 1 completes, then writes `ad_count` onto a record `cancel` may have already set to `CANCELLED`/`DRAFT` — producing a `CANCELLED` row with `ad_count>0` and the wrong "before any ads were created" messaging, or a relaunchable `DRAFT` with `ad_count>0`. (The other two race windows create no extra ads — the RPC gates on `status='LAUNCHING'` — but can leave a dangling `pending` JSONB on a terminal record.) **Fix:** in the cancel-detected re-check, when `result.created.length>0` set `PARTIAL` with accurate `last_error` and clear `draft_state`; optionally guard the process requeue/crash-handler `pending` writes with `.eq("status","LAUNCHING")`.

### C18 — Storage orphans in `launch-media`  ·  `cancel/route.ts:40` / `create/route.ts`
**Verified 1/2 (0 refutes; bucket lifecycle unverifiable from repo).** `cancel` clears `pending` without deleting queued rows' `launch-images/*`; `failRecord` (batch-1 total failure) orphans all `rest` images; a wedged launch's images are never cleaned. No bucket TTL is visible in the repo. **Fix:** on cancel and batch-1 failRecord, remove the queued `rest` rows' `imagePaths`; or add a periodic sweeper for `launch-images` objects unreferenced by any `ad_launches` row.

### N-launcher-secondary-0 — Ungrouped creatives in a Carousel launch become doomed 1-card "carousels"  ·  `components/launcher/AdLauncher.tsx:146` / `CarouselModal.tsx:32`
**Verified 2/2.** `CarouselModal` sets `adCount = carousels.length + ungrouped.length` and the footer only disables Continue when `adCount===0` — it does **not** require every creative to be grouped. Leaving creatives ungrouped in a carousel launch produces single-card "carousel" rows that `lib/launch.ts:709` rejects ("A carousel needs at least 2 cards") → those ads silently never launch though they appear normal in the grid. **Fix:** block Continue while `ungrouped.length>0`, or build ungrouped carousel-launch creatives as format `single`.

### C21 — `createOneAdSet` (duplicate-to-new-ad-set) bypasses the CBO guard, hardcodes LEAD_GENERATION  ·  `lib/launch.ts:520-551`
**Verified 3/3.** `createOneAdSet` (reached from `/api/ads/copy` and `/api/ads/duplicate` via `resolveDestinationAdSet` when `mode==='new'`, `campaignMode==='existing'`) does no CBO detection, no delivery cloning, and hardcodes `LEAD_GENERATION`/`ON_AD`/`{page_id}`. Attaching to an existing CBO campaign with mismatched optimization → raw Meta `100/1885760`; to an existing ABO campaign with the default `cbo` budgetMode → **no budget on either level** → Meta rejects; a website source ad still gets `LEAD_GENERATION`. **Reachability caveat:** both routes are orphaned (see C64), so this is latent. **Fix:** delete the two dead routes (cleanest), or route `createOneAdSet` through the same `getExistingCampaignDelivery`/CBO-guard logic as `prepareNewAdSets`.

### C23 — Rebuild-and-swap: can't edit website ads, leaks creatives, drops description/crops  ·  `app/api/ads/manage/route.ts:128` / `lib/meta-ads.ts:370-378`
**Verified 2/2.** `edit_ad` aborts when the ad has no resolvable lead form and no saved form was picked (line 128), so a landing-page/website ad's creative is **uneditable** (or forced to attach a form). If `updateObject` creative-swap fails after `createAdCreative` succeeded, the new creative is orphaned (no `deleteObject`); the old creative is never cleaned after a successful swap (unbounded accumulation); and the rebuild silently drops the original's `description` and `image_crops` because `getAdCreativeInfo` doesn't return them. **Fix:** allow genuine website ads through; forward `description`/`imageCrops` (read them in `getAdCreativeInfo`, pass to `createAdCreative`); `deleteObject(old)` after a successful swap and `deleteObject(new)` on swap failure.

### C24 — `archiveLeadForm` ignores the API response → reports success on failure  ·  `lib/meta-ads.ts:445` / `manage/route.ts:155`
**Verified 2/2.** `archiveLeadForm` POSTs `status=ARCHIVED` and never checks `res.ok`/`json.error`, returning void; `manage` action `archive_form` then returns `{ok:true, archived:true}` regardless of whether Meta actually archived. **Fix:** `await res.json()` and throw on `json.error`/`!res.ok` (mirror `createLeadForm`); the existing try/catch will surface it.

### C25 — Page-token Meta calls bypass `withRetry` (no code-17 backoff)  ·  `lib/meta-ads.ts:432,445,474-488,503`
**Verified 2/2.** `createLeadForm`/`archiveLeadForm`/`fetchAllPaged`(lead reads)/`getLead` use raw `fetch` to `LEAD_API` without `withRetry`, unlike `metaGet/metaPost`. A bulk launch minting one-off lead forms under a throttle fails immediately instead of backing off, and each re-mints a fresh page token (extra GET). **Fix:** route LEAD_API calls through a `withRetry` wrapper; memoize `pageAccessToken()`. Note `getLeadsForForm` also bypasses retry, so a code-17 aborts the whole leads sync (recovered next run).

### C26 — Process-lifetime null caching of pixel/IG actor poisons the warm lambda  ·  `lib/meta-ads.ts:101,106` / `lib/meta.ts`
**Verified 2/2.** `_pixelId`/`_igActor` cache `null` on transient failure for the whole warm lambda (`if (_pixelId !== undefined) return _pixelId;` + `catch { _pixelId = null; }`). One transient `adspixels` read failure makes **every subsequent landing-page launch in that instance fail with "No Meta Pixel found"** until a cold start. **Fix:** cache only successful lookups; leave the cache `undefined` on failure (or use a distinct sentinel for "confirmed no pixel" vs "fetch failed").

### C27 — Per-adset partial failure leaves an empty PAUSED ad set on the account  ·  `lib/launch.ts:824-835`
**Verified 2/2.** When `prepareNewAdSets` created a fresh per-audience ad set but its `createAd` then fails, only the unused *creative* is deleted (line 835); the empty ad set stays on the account PAUSED with no cleanup. **Fix:** track per-`adSetId` created counts; in "new campaign" mode, if `result.created` is empty, delete the campaign the launcher minted (cascades to its empty ad sets) — mirroring the existing `prepareNewAdSets` cleanup, and never touching a user-picked existing ad set.

### C30 — Missing GHL env silently drops GHL+Slack for every realtime lead  ·  `lib/ghl-push.ts:16` / `webhooks/meta-leads/route.ts:88`
**Verified 2/2.** `pushLeadToGhl` returns `{ok:false, skipped}` when `GHL_ADS_FOLDER_ID` or `N8N_LEAD_WEBHOOK_URL` is unset; the webhook discards the return with no log. A misconfigured env var means every realtime lead skips GHL+Slack while the route returns 200. **Fix:** log/`reportError` on the skipped path (guard against per-lead spam).

### C31 — Leads sync resets a qualified lead to "pending" and NULLs the GHL link on a phone no-match  ·  `lib/sync/leads.ts:83,104,108,118`
**Verified 3/3.** `runLeadsSync` builds each upsert row with `qualification`, `ghl_contact_id`, `ghl_name`, `ghl_tags`, `matched_at` populated unconditionally and upserts with `onConflict:"tenant_id,meta_lead_id"` (DO UPDATE over every column). On a no-match, `qualification` → `"pending"`, `ghl_contact_id`/`matched_at` → null — **overwriting a previously-qualified lead** (a phone edited in GHL, or a partial GHL pull, is enough). `indexContactsByPhone` also keeps only the *first* contact per phone key, so GHL duplicates mis-attach tags. This directly contradicts `captureLead`'s deliberate omission of these columns to preserve qualification. **Fix:** on no-match, omit `qualification`/`ghl_*`/`matched_at` from the row (mirror `captureLead`); guard the whole GHL block behind `ghlOn`; dedupe toward the tagged contact.

### C32 — Leads sync full-refetches every run; lead reads have no retry  ·  `lib/sync/leads.ts:68` / `lib/meta-ads.ts:474-488`
**Verified 2/2.** `getLeadsForForm(f.id)` is called with no `sinceUnix` (incremental filtering is supported), re-reading every lead of every form (archived included) each 30-min run; `/api/leads/refresh` lets any signed-in user trigger it. `fetchAllPaged`/`getLead` have no retry, so one transient Meta blip fails the run. Burns rate budget (compounds C17). **Fix:** pass `sinceUnix = max(created_time) - overlap`; wrap lead reads in `withRetry`.

### C33 — Webhook inline processing risks Meta redelivery → duplicate Slack notifications  ·  `webhooks/meta-leads/route.ts` / `lib/ghl-push.ts:41`
**Verified 2/2.** The POST handler processes each lead inline before responding (Meta fetch + DB + up-to-N Anthropic calls + GHL upsert with ~5.6s retry + n8n POST). Slow GHL or multiple leads can push the response past Meta's webhook ack timeout → redelivery. DB/GHL upserts are idempotent, but the n8n→Slack POST is **not**, so it duplicates. **Fix:** dedupe the n8n notification on `meta_lead_id` (only POST when `captureLead` inserted a new row), and/or move the pipeline into `after()`/a queue with a fast 200.

### C38 — Cross-source lead dedup relies solely on `meta_lead_id`  ·  `db:public.leads` / `leads/website/route.ts:101`
**Verified 2/2.** `leads` has `UNIQUE(tenant_id, meta_lead_id)` only; website leads synthesize `web:<phone|email>` while instant-form leads use the Meta leadgen id. The same person via both channels creates **two lead rows** (the dashboard shows two). GHL already dedups by phone/email, so "two GHL contacts" is not a concern. **Fix (if unique-human counts matter):** dedup at the view layer (`fetchLeadViews`) by `phone_norm`/`email_norm` — the non-unique norm indexes already exist. Do **not** add a DB unique on phone/email (a website "started" and a later instant-form submit are genuinely distinct events).

### C39 — Unbounded dashboard selects will silently truncate at the PostgREST row cap  ·  `lib/queries.ts:224-229`  ·  **latent**
**Verified 2/3 (1 refuted on "no cap currently configured").** `getDashboard` selects `fb_insights_daily` for the range `.order("date",{ascending:true})` with **no `.limit()`/`.range()`**, feeding all totals/charts. Supabase defaults the PostgREST response to 1000 rows. Once `fb_insights_daily` rows (ads × active days) exceed the cap, ascending order means the **most recent days are dropped** from totals/charts, understating spend/leads with no error. **Current state: 67 rows / 36 ads — well under 1000, so not yet triggering** (and one skeptic found no explicit `pgrst.db_max_rows` in role settings; the effective REST cap is a gateway setting not readable via SQL — see Appendix). **Fix:** paginate via `.range()` until exhausted, or push aggregation into a SQL/RPC view. Same class as N-completeness-critic-1 below.

### N-completeness-critic-1 — Leads CRM + qualification tallies truncate at the PostgREST cap  ·  `lib/leads-data.ts:12`  ·  **latent**
**Verified 2/2.** `fetchLeadViews` does `.select(...).eq("tenant_id",...).order("created_time",desc)` with no `.limit()`/`.range()` — once the tenant exceeds ~1000 leads, the CRM and all its qualification tallies cover only the newest 1000. Currently 7 leads → dormant. **Fix:** paginate with `.range()` in a loop.

### N-read-layer-misc-1 — `recommend()` says "Running normally" for a zero-lead ad that spent past the gate  ·  `lib/recommend.ts:22`
**Verified 2/2.** For an ad that is past the spend gate (e.g. €60 vs €40) with **0 leads**, `cpl` is null (leads>0 false) and `gated` is false, so the D-flag branches all fall through to the "Running normally" fallback — the app tells the operator a money-burning zero-conversion ad is fine. **Fix:** before the fallback, add `if (!a.gated && a.leads === 0) return "Spent €X past the €Y gate with no leads — investigate the offer/landing page."` (`leads` is already on `AdPerf`).

### N-meta-param-deep-0 — FB-only "In-stream" + Instagram enabled → incoherent targeting  ·  `lib/launch.ts:108` / `lib/placements.ts:16`
**Verified 1/2 (0 refutes; 1 errored).** With Instagram enabled and only the FB-only `instream` placement group selected, `buildPositions` returns `facebook_positions:["instream_video"]` and `instagram_positions:undefined`, but `publisher_platforms` still includes `instagram` → Instagram is a platform with no positions (incoherent targeting Meta may reject or silently mis-deliver). **Fix:** when manual placements are used, drop any platform from `publisher_platforms` whose positions array is empty.

### C43 — Unvalidated `from`/`to` searchParams → page crash or empty charts  ·  `lib/queries.ts:199-206`
**Verified 2/2.** `opts.from`/`opts.to` flow from URL searchParams straight into `.gte/.lte` on a `date` column and into `isoWeek()`/`daysInclusive` date math. `isoWeek` does `new Date(str+"T00:00:00Z").toISOString()`, which throws `RangeError` on a malformed value → **the whole Overview/Ads Manager page 500s** (there is no `error.tsx` boundary — see Appendix); a garbage-but-non-throwing value yields `NaN` ranges and empty charts. **Fix:** validate `from`/`to` against `/^\d{4}-\d{2}-\d{2}$/` (and real-date parse) at the top of `getDashboard`, falling back to defaults; add an app-level `error.tsx`.

### C45 — Reach/frequency ignore the selected date range  ·  `lib/queries.ts:232`
**Verified 2/2.** The `fb_insights_window` read is `.order("window_end",desc)` with **no `.gte/.lte`** — it always uses the newest window per ad regardless of the selected `[from..to]`. Selecting a historical range still shows *today's* frequency, unlabeled. **Fix:** select per ad the window whose `window_end` is latest ≤ the range's `to`, and/or disclose the window's actual end date in the AdTable "Freq" column.

### C46 — Stale daily rows never cleaned inside the resync window  ·  `lib/sync/facebook.ts:301-305`
**Verified 2/2.** The daily upsert writes only rows Meta returns; if Meta restates a day to zero or omits an ad's row, the old `fb_insights_daily` row persists forever → spend permanently disagrees with Ads Manager for restated days. **Fix:** delete in-range `(ad_id,date)` rows not returned before re-inserting — but with the same guard as `reconcileDeleted` (never delete on a failed/empty pull); or run a periodic full-range reconcile.

### C50 — Lead-form builder wipes in-progress edits on a parent re-render  ·  `LeadFormBuilderModal.tsx:115` / `AdSetup.tsx:269`
**Verified 2/2.** The edit-load effect deps are `[editId, onClose]`, and `onClose` (`closeFormBuilder`) is a fresh function identity every `AdSetup` render. AdSetup re-renders repeatedly for seconds after entry (the `autoName` async pool fires `setState` per image). So editing a saved form during that window re-runs the fetch and resets every field — **silently clobbering the user's typing**. **Fix:** depend on `[editId]` only (or guard with a `loadedFor` ref).

### C54 — PreviewModal re-fetches (a Meta call) on every unrelated row patch  ·  `PreviewModal.tsx:57`  ·  **PLAUSIBLE**
**Verified split (1 CONFIRMED P2, 1 REFUTED-as-structural-sharing).** Effect deps `[row, creatives]`; `row` is re-found from state each render. A patch that replaces the row object — notably `autoName` filling `row.name` (`AdLauncher.tsx:173`) — changes the reference and re-fires `/api/ads/preview` (a server-side Meta call), even though `name` isn't in the preview payload. The refuter argued structural sharing keeps the reference stable for *unrelated* rows, but the auto-name path patches *this* row. **Fix:** key the effect on the stable primitives the preview actually uses (`row.id`, `primaryText[0]`, `headline[0]`, `cta`, `creativeIds[0]`).

### C22 — CBO guard silently falls back to ABO on a campaign-read failure  ·  `lib/launch.ts:321-323,385`  ·  **PLAUSIBLE**
**Verified split (1 CONFIRMED P2, 1 REFUTED via the client forcing `budgetMode:"cbo"` for existing campaigns).** If `getExistingCampaignDelivery` throws, `isCbo` stays false, so the CBO guard (`if (existingMode && forceCbo)`) is skipped. The refuter noted the client always sends `budgetMode:"cbo"` for existing campaigns (`AdSetup.tsx:534`), so `abo` is false regardless and no ad-set budget is sent — closing the specific "budget into a CBO campaign" path via the UI. Residual real risk: the optimization-mismatch guard is skipped on an unreadable campaign (raw Meta rejection surfaces), and the `/adsets` template read is a single unpaginated `limit=20`. **Fix:** treat an unreadable campaign as a hard error (don't default to ABO); paginate the `/adsets` read.

### C36 — CAPI silently disabled without `event_id`  ·  `leads/website/route.ts:194`  ·  **PLAUSIBLE**
**Verified split (2 UNCERTAIN — client-dependent).** `fireCapi` requires `b.event_id`; a paid lead lacking it yields no CAPI event and no alert (the `reportError` sits inside the `if (fireCapi)` block). Whether this loses conversions depends on the landing-page wiring (the "other window", not in this repo; `website-audit-source-tracking` memory flags it "pending"). The server design is *correct* per SOURCE-TRACKING (firing without `event_id` would double-count against the browser pixel). **Fix:** the only in-repo change is observability — `console.warn`/`reportError` when `isPaidClick(b) && !b.event_id` so a contract violation is visible rather than silent.

---

## CONFIRMED findings — P3 (polish / drift / latent)

| ID | Finding | Location | Fix (short) |
|----|---------|----------|-------------|
| C4 | `/process` secret compared with `!==` (not timing-safe) while siblings use `timingSafeEqual` | `launches/process/route.ts:16` | Use `timingSafeEqual` over equal-length Buffers |
| C5 | `webhooks/meta-leads` GET verify-token compared with `===` | `webhooks/meta-leads/route.ts:27` | Optional: constant-time compare (POST is HMAC-protected) |
| C6 | Session-cookie mutation routes have no CSRF/Origin check (SameSite=Lax mitigates) | `ads/manage`, `settings`, … | Add Origin allowlist / double-submit token as defense-in-depth |
| C7 | `/api/presets` POST/DELETE not admin-gated — any user mutates shared presets | `presets/route.ts:10,56` | Add `isAdminUser`, or accept as intended (launcher is user-open) |
| C19 | `launched_at` displayed under "Launched" but never written → falls back to `created_at` | `launch/page.tsx:19`, `LaunchHistory.tsx:183` | Write it at terminal state, or rename column to "Created" |
| C20 | Dead statuses: `PENDING` accepted but never sent; `LIVE` styled but never written; type comment wrong | `launches/route.ts:8`, `types.ts:149` | Trim `ALLOWED_STATUS`/`STATUS_STYLE`; fix the union comment |
| C34 | Started/completed Slack duplicate race (~900ms window) | `leads/website/route.ts:178` | Poll-retry loop instead of a single 900ms wait |
| C35 | Write-once Lead Source race; `isFieldEmpty` returns false on GHL read error → skips first-touch | `lib/ghl-write.ts:119` | Conditional/atomic write-once; self-heals next event |
| C37 | `fbclid` accepted in website Body but never read (dead) | `leads/website/route.ts:62` | Remove, or forward it so `fbc` can be derived server-side |
| C42 | `weekRes.error` never checked → failed weekly query renders an all-zero chart | `lib/queries.ts:240` | Add `if (weekRes.error) throw weekRes.error;` |
| C44 | Overview "Leads" KPI (insights actions, range-scoped) vs Leads page (all `public.leads`) diverge | `queries.ts`, `leads-data.ts` | Relabel/date-scope; definitionally different sources |
| C47 | `daysAgoInTz` recomputes "today" per call → a midnight-straddling sync can write a 1-day-short window row | `sync/facebook.ts:308`, `time.ts:41` | Capture `today` once and derive all boundaries from it |
| C51 | SettingsForm optimistic boolean/enum never reverts on save failure | `SettingsForm.tsx:129-133` | Restore prior value in the error/catch branches |
| C52 | TeamManager `setRole`/`remove` use try/finally with no catch → unhandled rejection, no feedback | `TeamManager.tsx:60-87` | Add a catch with user feedback (mirror `add()`) |
| C53 | Meta ad-preview HTML injected raw via `dangerouslySetInnerHTML` | `AdEditPanel.tsx:182`, `PreviewModal.tsx:73` | Exploitability ~nil (Meta iframe); sandbox the wrapper if hardening |
| C56 | LaunchProgressModal countdown subtracts client clock from server timestamp → skew | `LaunchProgressModal.tsx:70` | Count down from a local anchor, or return `secondsUntilNextBatch` |
| C59 | Stat value uses `font-semibold` (DS mandates `font-medium`) | `LaunchProgressModal.tsx:103` | `font-semibold` → `font-medium` |
| C60 | `EditableName` name cells have no truncation → long Meta names overflow drill-down tables | `EditableName.tsx:17`, `LaunchHistory.tsx:138` | Add `max-w-[220px] truncate` (parity with AdTable) |
| C61 | `group-hover` on the "Need new creatives?" card has no `group` ancestor → dead hover | `AdLauncher.tsx:410,418` | Drop the dead `group-hover` classes (card is a placeholder) |
| C66 | AdEditPanel says "build one on the Create page" — a deleted route | `AdEditPanel.tsx:150` | Reword to "build one on the Launch page" (static text) |
| C68 | `lead_form_settings` table orphaned — no code reads/writes it (defaults come from `lead_form_templates`) | `db:public.lead_form_settings` | Confirm unused and drop, or document |
| C69 | `fb_event_health` unique key includes nullable `account_id` → NULLs never conflict → dup rows (latent; empty) | `db:public.fb_event_health` | `NULLS NOT DISTINCT` or make `account_id` NOT NULL when a writer is added |
| N-read-0 | AdDrawer "CPC (link)" actually shows cost-per-**all**-clicks (`spend/clicks`) | `AdTable.tsx:334`, `queries.ts:313` | Relabel "CPC (all)" or add a real `linkCpc = spend/linkClicks` |
| N-meta-2 | `withRetry` retries non-idempotent create POSTs on transient code 1/2 → **possible duplicate campaign/adset/ad** (compounds C9) | `lib/meta.ts:77` | Retry creates only on rate-limit codes (rejected pre-creation); or add an idempotency/existence check |
| NP3 | "+ Add Ads" during a carousel launch appends invalid 1-card carousel rows | `AdLauncher.tsx:240` | Disable in carousel mode or coerce to `single` |
| NP3 | No max on carousel cards → a >10-card carousel is buildable and Meta-rejected | `CarouselModal.tsx:33` | Cap at 10; add a `media.length>10` guard in `launch.ts` |
| NP3 | Framing an already-Feed-fitting image saves a bogus non-4:5 crop Meta rejects (retried without crop, wasting a call) | `CropModal.tsx:71` | Hide/disable Done when `tooWide`; gate "Frame for Feed" on aspect<0.8 |
| NP3 | Decisions page dumps fatigue/CPM-spike ads into "Leave alone — fine as-is" | `decision/page.tsx:12`, `queries.ts:482` | Add a "Needs attention" bucket for actionable flags |
| NP3 | `normalizeQuestions` builds colliding Meta field keys for same-slug custom questions/options | `lib/leadform.ts:26` | De-dup keys with a used-key Set + suffix |
| NP3 | Meta fetch helpers never check `res.ok` → a 5xx HTML body throws a `SyntaxError` that bypasses the transient classifier (no backoff) | `lib/meta.ts:96` | On `!res.ok`, throw a transient-tagged error for 5xx/429 before `res.json()` |
| NP3 | Open redirect after login via unvalidated `redirect` param | `LoginForm.tsx:27` | Accept only paths starting `/` and not `//` |

---

## PLAUSIBLE findings (could not be fully confirmed or refuted)

- **C41** (reconcileDeleted cascade) — promoted into the P1 list above with the corrected, *confirmed* trigger (archived-object exclusion). Listed as plausible only because the original throttle trigger was refuted; the destructive path itself is real.
- **C22** (CBO guard → ABO fallback) — the UI-forced `budgetMode:"cbo"` closes the budget path; the optimization-mismatch + unpaginated-`/adsets` residual is real. Details in P2 section.
- **C36** (CAPI without `event_id`) — depends on landing-page client wiring outside this repo. Server behavior is correct-by-design.
- **C54** (PreviewModal refetch) — real on the auto-name path; a skeptic argued structural sharing limits it. Details in P2 section.

## KILLED findings (verified refuted — reported for transparency)

- **C65** — "batched self-chain uses hardcoded prod URL / `NEXT_PUBLIC_APP_URL` unread." *Refuted 2/2:* the facts are true but intended — the self-chain deliberately targets the stable public alias (a preview deploy hitting prod is the *correct* behavior, since only prod carries the queue). Optional P3 cleanup: remove the unused `NEXT_PUBLIC_APP_URL` from `.env` or document `LAUNCH_BASE_URL`.
- **C67** — "`ADMIN_EMAIL`/`SLACK_AUDIT_CHANNEL` absent from `.env`." *Refuted:* both are explicitly documented as optional overrides with intended hardcoded fallbacks; absence is by design (and Vercel env is not the repo `.env`).
- **C55** — "duplicate-load error path leaks object URLs." *Refuted:* the triggering throw (`dataUrlToFile` on a malformed data URL) is unreachable on that path; orphaned URLs are freed on reload regardless.

---

## Special assessment — the known batch-1 cleanup gap (`create/route.ts`)

The briefing flagged this as a known gap to *assess*, not re-report. Two mechanisms, both verified:

**1. Failed batch-1 rows are silently dropped, and their images deleted.** `rest = rows.slice(BATCH_SIZE)` (`create:145`) never re-includes batch-1 rows whose `createAd` failed, and `cleanup(paths)` (`create:134-135`) unconditionally deletes *all* batch-1 images. So a batch-1 row that fails is gone — not retried, image deleted.

**2. The shortfall is then reported as a full success.** `total_ads = rows.length` (`create:161`), but when the queue later drains, `process:59-60` sets `status:"PAUSED"` and **clears `last_error`** without comparing `ad_count` to `total_ads`. Net: a launch that created, say, 22 of 25 intended ads ends in the green "PAUSED / done" state with no error and no indication three ads never launched (this is **C15**, verified 2/2).

**Real-world severity: P2, leaning P1 for a spend-sensitive operator.** It cannot create *wrong* ads or corrupt live campaigns, and the common path (all batch-1 rows succeed) is unaffected. But it silently under-delivers a paid launch while reporting success — the operator believes 25 ads are live when 22 are, and the 3 failures leave no trace (compounded by the Toaster having no error variant, C57). It is most likely to bite exactly when Meta is throttling (code 17), i.e. the same conditions C17/C32 make more frequent.

**Minimal fix (two small changes):**
1. In `create/route.ts` batch-1, compute `createdNames` from `result.created` and **append the un-created batch-1 rows to `rest`** (mirroring `process/route.ts:47-49`), and delete images **only for created rows** (mirror `process/route.ts:53-55`) so failed rows keep their media for retry.
2. At the terminal drain (`process/route.ts:59-60`), when `ad_count < total_ads` set `status:"PARTIAL"` with a `last_error` noting the shortfall instead of `PAUSED`/`last_error:null`.

---

## Business-invariant conformance

| # | Invariant | Verdict |
|---|-----------|---------|
| 1 | Every Meta object created PAUSED | **HOLDS.** Every `createCampaign/createAdSet/createAd/copyObject/createOneAdSet` defaults/passes `status:"PAUSED"`; `resumeObject` (`meta-ads.ts:19`) is the only ACTIVE writer, reached only from the explicit `manage` "resume" action. |
| 2 | Status never changed programmatically without explicit user action | **HOLDS.** `runFacebookSync` only mirrors status *into* the DB, never pushes to Meta; rebuild-and-swap re-submits for review but doesn't toggle active. |
| 3 | Single tenant / id-only lookups | **BY DESIGN** — not flagged (per user decision). Note: RLS is structurally dead (`public.users` empty → `current_tenant_id()` null), so route-level auth is the *only* real access control — hence the weight of C1/C2/C3/N-team. |
| 4 | EUR only, no FX | **HOLDS.** No FX anywhere; budgets are `Math.round(eur*100)` cents; `format.ts` hardcodes EUR; sync hard-fails if the account currency ≠ EUR. |
| 5 | `qualified` gates ONLY Meta CompleteRegistration CAPI | **HOLDS in code**, but C2 shows the gate input (`body.qualified`) is attacker-controllable on the public endpoint; website `audit_qualified` is correctly kept out of `leads.qualification`/GHL tags. |
| 6 | System does not defend against deploy-during-launch / Meta-reads-during-launch | **CONFIRMED as a gap** — convention only. C10 (deploy kills the fire-and-forget chain), C17 (the UI itself reads Meta every 4s during a launch). |
| 7 | Prod deploys don't auto-move the alias | Nothing in code assumes otherwise; C10 is the one place a hardcoded alias matters, and it targets the stable alias intentionally. |

---

## Appendix — what could not be verified without live/runtime access

- **PostgREST effective row cap (C39, N-leads-1000).** Supabase's REST "Max rows" is a gateway config not readable via SQL/MCP; one skeptic found no `pgrst.db_max_rows` role GUC. Both findings are latent (current counts 67 / 7 rows). **Action:** confirm the project's API "Max rows" setting in the Supabase dashboard; if 1000 (the default), paginate the unbounded selects before row counts grow.
- **Vercel production env vars.** `ADMIN_EMAIL`, `SLACK_AUDIT_CHANNEL`, `LAUNCH_BASE_URL`, `SYNC_TRIGGER_SECRET`, `NODE_ENV` in the live Vercel project were not inspected (only the repo `.env` name list). C3's exploitability and C67's dismissal both assume Vercel sets `NODE_ENV=production` (it does) and that the hardcoded admin fallback matches the real admin.
- **Meta API runtime behavior.** Zero Meta calls were made (per constraints). All Meta-API findings (C9, C11, C21–C27, C41's archived-exclusion, N-meta-0/2) are reasoned from code + documented Graph behavior. The exact webhook ack timeout (C33) and whether `status_option=PAUSED` is honored for deep copies (C21 area) are runtime facts.
- **Landing-page / "other window" client wiring.** C2, C36, C37 depend on what the external landing page actually sends (`event_id`, `fbc`, the token's exposure). Not in this repo.
- **n8n live state.** The repo's `facebook-sync.workflow.json` is `"active": false` with a NoOp error branch; the live n8n instance state is unknown. If the scheduled sync is not actually running, the leads-qualification sync (C31) and insight freshness are affected in the opposite direction.
- **Supabase Storage lifecycle.** C18's severity depends on whether the `launch-media` bucket has a TTL rule (not visible in repo). If none, orphans accumulate unbounded.
- **`processInstances` / warm-lambda behavior.** C26's blast radius depends on Vercel's function reuse; the null-cache poisoning lasts until a cold start.

## Build / typecheck

- `npx tsc --noEmit` (excluding `.next/types/* 2.d.ts` cloud-sync duplicates): **0 errors.**
- `npm run build` was **not run** — the dev server was live on :3000, and the safety constraints forbid a build while dev is running (shared `.next` corruption risk per `build-deploy-safety`). Per that same memory, `tsc` alone does not catch Turbopack-only parse errors, so a clean Turbopack `npm run build` (with the dev server stopped) remains an outstanding gate before the next deploy.

---

*Audit performed read-only via 4 phases of multi-agent orchestration (Phase 0 map → Phase 1 fresh-lens finders → Phase 2: 128 refute-mandated skeptics → Phase 3: completeness critic + gap round + re-verification). 67 candidates → 74 CONFIRMED, 4 PLAUSIBLE, 3 KILLED. No fixes were applied.*
