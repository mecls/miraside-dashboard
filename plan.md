# Meta Ads + GHL Performance Dashboard — Build Plan (v4, consolidated)

**This is the single source of truth.** It supersedes all earlier plan versions and folds in the audit fixes and the four locked decisions. The audit trail (every finding and *why* each change was made) lives in `PLAN-REVISIONS.md`; this file is *what to build*.

A Facebook/Meta Ads performance dashboard for a **service-based** business that joins Meta ad-spend with GoHighLevel (GHL) pipeline data, stores it in Supabase, and presents reporting **and** decision-support views. Internal tool first; multi-tenant from day one.

**"Done" = every acceptance criterion in §11 passes.**

---

## Locked decisions (the four that reshape everything)

1. **Currency = EUR, native only.** All money is EUR. Sources must already be EUR (FB ad-account currency *and* GHL deal values). No FX engine — enforce EUR at onboarding instead (reject/flag non-EUR).
2. **Lead capture is via a LANDING PAGE / opt-in, not native FB instant forms.** Per-ad attribution is therefore *not* automatic — it depends on Facebook URL parameters captured into the form. Per-ad join key = `fb_ad_id`. `fbclid` is CAPI-only, **never** a join key.
3. **Every decision threshold is tenant-configurable**, not hardcoded — a settings model with defaults (§5). The user sets the numbers; nothing is baked into code.
4. **"Connect rate" is cut** (the old B11 metric and D9 flag) — never intended, no data source.

---

## 0. Framing decisions

1. **Service-based B2B, not e-commerce.** Spend → Leads → Meetings → Held → VAs → Closed → CAC/ROAS. Facebook only knows spend, impressions, lead-submits. Everything past "Lead" lives in **GHL**. Core job = the **join**.
2. **The join key is `fb_ad_id` captured at lead creation** (via landing-page URL parameters — §3). Without it, funnel-past-lead is account-level only, never per-ad.
3. **Store, then read. Never poll live.** Meta throttles (613/80004); refresh 15–60 min + manual.
4. **Trust the CRM for funnel stages; FB conversions secondary.** iOS gutted pixel reliability.
5. **The dashboard advises; it never auto-acts.** Every kill/scale rule is a flag, not an action.
6. **Revenue books by close-month.** A lean month is acceptable and labeled, not flagged red. Because service deals close weeks/months after the lead, a recent ad's per-ad ROAS shows "still maturing" until its deals close — honest, not a failure state. The "recent" boundary is the configurable `deal_cycle_days` (default 14).
7. **Low volume = noise-aware.** Small swings aren't signal. Default to longer windows; show "insufficient data" readily. All noise floors are configurable.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js (App Router)** | SSR fetching, API routes, auth middleware. |
| UI + charts | **Tremor** on shadcn/ui + Tailwind | Analytics components; design tokens for rebrand. |
| DB | **Supabase (Postgres)** | Postgres + Auth + RLS + Vault. |
| Auth | **Supabase Auth** | Drives RLS via `auth.uid()`. |
| Isolation | **Postgres RLS** | Every row `tenant_id`; auto-enforced. |
| Secrets | **Supabase Vault** | Encrypts FB + GHL tokens at rest. |
| Sync | **n8n** (preferred) or Supabase Edge cron | Scheduled Meta + GHL pulls. |
| Hosting | **Vercel** + Supabase cloud | |

Build multi-tenant from day one — you're tenant #1.

---

## 2. Architecture

```
  Next.js app (Vercel): Dashboard UI (Tremor) · Supabase Auth · Settings UI ·
  Onboarding (connect FB+GHL, EUR guard, map stages, verify capture fields)
        |  reads (RLS-scoped, anon key + user JWT) — all flag logic reads effective_settings
        v
  Supabase (Postgres):
    tenants / users / connections · ad hierarchy
    fb_insights_daily · fb_insights_window (de-duplicated window reach/frequency)
    fb_event_health · audience_segment_daily · ad_status_history
    ghl_contacts · ghl_opportunities · pipeline_stage_map
    setting_definitions · tenant_settings · effective_settings (view)
    joined_performance (view) · Vault (encrypted tokens) · RLS on all
        ^  writes (service role, idempotent upserts + sync watermark)
   FB sync (n8n): /insights per ad (daily) + /insights per window (reach/freq) + backfill
   GHL sync: webhook (last-write-wins by event ts) + nightly reconcile
        v
   Meta Graph API (System User)        GoHighLevel API (location key)
```

---

## 3. The attribution join (landing-page capture)

**Problem:** FB says "ad X spent €40, 3 leads." GHL says "contact Y closed €15k." Nothing connects them natively. Because leads arrive through a **landing page / opt-in** (not a native FB instant form), the ad identity is **not** automatically attached — we must capture it ourselves.

**Capture mechanism (one-time setup; this is mandatory, not optional):**
1. **Meta Ads Manager** — each ad's *URL parameters* field = `ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}`. Facebook fills the macros per ad and appends `fbclid` itself.
2. **Opt-in page** — JS reads those params on load and writes them into **hidden form fields**; persist to localStorage/cookie so multi-step funnels don't lose them before submit.
3. **Form → GHL** — hidden fields map to contact custom fields `fb_ad_id`, `fb_adset_id`, `fb_campaign_id`, `fbclid`.

**Join logic:** GHL contacts → `fb_insights_daily`/`fb_insights_window` by **`fb_ad_id` (exact)**. A contact with no `fb_ad_id` falls to **account-level attribution only**, and the UI says so. There is **no fbclid join** — `fbclid` cannot resolve to an ad on its own; it is used solely to fire Meta CAPI server-side events on stage changes. **GHL is the source of record for stages; FB conversions secondary.**

**Capture health (mandatory):** onboarding verifies the four custom fields exist **and** a populate-probe / capture-rate monitor confirms they actually fill — % of last-30d contacts with non-null `fb_ad_id`, warning below `capture_rate_warn_pct` (default 70%). "Field exists" ≠ "field is populated"; a landing page that drops the params fails silently otherwise.

**Close-month note:** the join ties spend↔close per *ad* regardless of month, so a June ad's September close still credits that ad's per-ad ROAS (headline revenue still books by close-month — §6).

---

## 4. Metrics — tiered for a service business

Per-ad table defaults to **Tier 1**; Tiers 2–3 expand on demand. Every threshold below is a configurable setting (§5).

### TIER 1 — Daily watch (KPI strip + main table)

| Metric | Source | Formula |
|---|---|---|
| Total Ad Spend (A1) | FB | `spend` (EUR) |
| Leads Generated (A2) | GHL primary / FB cross-check | attributed contacts = lead-form submit |
| Cost Per Lead (A3) | derived | spend ÷ leads |
| Conversion Rate (A4) | derived | **account-level:** leads ÷ link clicks; **per-ad:** `fb_leads ÷ link_clicks` (same FB grain — avoids the join-subset bias) |
| Meetings Booked (A6) | GHL | opps at booked stage |
| Cost per Meeting (A7) | derived | spend ÷ meetings (maturing-aware) |
| 1st Meetings Held (A8) | GHL | stage |
| 2nd Meetings Held (A9) | GHL | stage |
| VAs — Verbal Agreements (A10) | GHL | stage |
| Closed count (A11) | GHL | Won |
| Closed value (A12) | GHL | Σ `monetary_value` on Won, **by close-month**; null-value Won opps excluded (not 0) and surfaced |
| CAC (A13) | derived | spend ÷ closed count (maturing-aware) |
| ROAS (A5) | derived | closed value ÷ spend; **"maturing" state** when ad age < `deal_cycle_days` |
| Frequency (B1) | FB | **window-level** impressions ÷ reach from `fb_insights_window` — never summed from daily reach |

Each KPI card shows period-over-period delta. ROAS / CAC / cost-per-meeting on recent ads render **"revenue still maturing — spend €X, €0 closed, N opps open"** instead of a misleading 0.

### TIER 2 — Diagnostic (open when an ad looks off)
CTR-all (B5, ~2% industry reference — display only, not a flag input), CTR-link (B6, ~1% reference), CPC-link (B7), CPM (B4), Link clicks (B12), LP views (B13), Spend share (B14), Cost-per-result (B15). **Video-only (if running video lead ads):** Hook rate (B8), Hold rate (B9), Scroll-stop (B10).
*(Connect rate removed.)* Soft metrics have no reliable correlation with cost-per-result — see flag D7.

### TIER 3 — Setup / health
EMQ (B17, target = `d11_emq_min`; account/event-level, surfaced as an **account banner**, not a per-ad badge). Audience-segment split — New/Engaged/Existing (C11). Creative-diversity count (C12, optional note). Incremental attribution (B16): optional column, **not** a flag input, best-effort, "not statistically meaningful at low deal volume."

### REMOVED (ecom-only): checkout-initiated (B19), checkout→purchase (B20), per-stage ecom cost / ATC (B21). GHL stage costs replace these.

### 4C. Decision-support flags
Colored badge on each ad row, one-line hover. Every threshold is a `§5` setting.

- 🟢 **Scale — pour budget in** (D0, *new*): the positive flag. See §5 "Scale rule."
- 🟢 **Feeder / carrying the account — DO NOT KILL** (D2): spend share > `d2_spend_share_min_pct` + rel-ROAS < `d2_rel_roas_max` + freq < `d2_freq_max`.
- 🟡 **Retargeting disguised as winner — DO NOT SCALE** (D3): ROAS > `d3_roas_min` + freq ≥ `d3_freq_min`.
- 🔴 **Creative fatigue** (D4): freq > `d4_freq_min` AND CTR down ≥ `d4_ctr_decline_pct` vs the trailing-`d4_trailing_window_days` **mean** (not peak), persisting ≥ `d4_persist_days`, gated by `d4_min_impressions`/`d4_min_clicks`.
- 🟠 **Audience saturation** (D5): trailing-`d5_trailing_window_days` window-reach growth < `d5_reach_growth_max_pct` AND freq > `d5_freq_min`.
- ⚪ **Niche pocket — leave on** (D6): spend share < `d6_spend_share_max_pct` + cost-per-result ≤ `d6_cpr_ratio_max × target_cpl_eur`.
- 🔵 **Soft-metric/result divergence — DON'T "FIX"** (D7): CTR/CPC in bottom `d7_ctr_percentile_max` percentile but cost-per-result ≤ `d7_cpr_ratio_max × target_cpl_eur`.
- **CPM spike** (D8): CPM > `d8_cpm_spike_multiple` × trailing-`d8_baseline_window_days` **median**, ≥ `d8_min_history_days` history, days < `d8_min_impressions_day` excluded.
- **True kill/reallocate candidate** (D10): past `d10_spend_gate_multiple × target_cpl_eur` spend + prospecting freq + cost-per-result over target by ≥ `d10_below_target_margin_pct` + an alternative ad ≥ `d10_realloc_better_margin_pct` cheaper.
- **EMQ/tracking health** (D11): lead-event EMQ < `d11_emq_min` (account banner).
- **Late-attribution reactivate** (D14): paused ad gets a Won conversion within `d14_lookback_days` of its last pause → "reactivate?"

**Frequency → funnel position (D1):** prospecting < `d1_freq_prospecting_max` · mid · retargeting ≥ `d1_freq_retargeting_min`.

**Spend-before-judging gate (D12):** per-ad spend < `d12_spend_gate_multiple × target_cpl_eur` → **"insufficient data."** Per-adset younger than `d12_adset_min_days` → "still learning" (`d12_adset_day_floor` hard floor). Default window = `reporting_window_days` (30); small-sample warning when window results < `small_sample_min_results`.

**Budget-scaling guidance (D13):** `d13_scale_increment_pct` (+25%) every `d13_scale_cadence_days` (3d); `d13_aggressive_increment_pct` (+40%) / double (if `d13_allow_double_below_low_spend`) when campaign daily spend < `d13_low_spend_daily_eur`; highest-rel-ROAS campaign should hold the highest budget (flag misallocation).

---

## 5. Configurable thresholds (the settings model)

**Nothing is hardcoded.** Every number above is a tenant-settable value with a default. The user sets the economics; sensible Meta-media-buying defaults cover the rest, tuned conservative for low volume.

### 5A. Storage (3 objects + RLS)
- **`setting_definitions`** — global catalog: `key` (PK), `label`, `description`, `value_type` (currency/percent/days/ratio/count/enum/boolean), `unit`, `default_value` (jsonb), `suggested_min`, `suggested_max`, `enum_options` (jsonb), `used_by`. Seeded once; globally readable, service-role-writable.
- **`tenant_settings`** — *sparse* overrides: PK `(tenant_id, key)`, `value` (jsonb), `updated_by`, `updated_at`. A row exists only when a tenant changes a default. Write = `INSERT … ON CONFLICT (tenant_id,key) DO UPDATE`. A BEFORE-write trigger validates type / range / enum membership. RLS by `tenant_id`.
- **`effective_settings`** (view) — `coalesce(override, default)` per `tenant × key`. Every tenant always has a complete set; a new tenant runs on defaults with zero override rows; deleting an override reverts to default.
- **All flag logic and `joined_performance` read only from `effective_settings`** (pivoted to one row, CROSS JOINed once) — no literals. Cost thresholds resolve as `d6_cpr_ratio_max * target_cpl_eur`; spend gates as `d12_spend_gate_multiple * target_cpl_eur`. Change a setting → flag output changes on next read, no redeploy.

### 5B. The Scale rule (D0 — the positive flag)
An ad earns 🟢 **Scale** only when it is data-sufficient, still-**fresh prospecting**, beating cost targets, out-performing the account, with audience headroom. **Must pass ALL:**
1. Data-sufficient (D12 cleared): spend ≥ `d12_spend_gate_multiple × target_cpl_eur` AND adset age ≥ `d12_adset_min_days`.
2. Prospecting-grade: window frequency < `d1_freq_prospecting_max` (1.3).
3. Cost under target: cost-per-lead ≤ `d6_cpr_ratio_max × target_cpl_eur`.
4. Relative outperformer: rel-ROAS ≥ 1.0 on `rel_roas_baseline` (account avg).
5. **Maturation-aware ROAS:** if ad age > `deal_cycle_days` → realized matured ROAS ≥ `target_roas` AND not still "maturing"; if younger → skip this check (conditions 3–4 carry it, so a long close cycle never blocks a clearly-winning young ad).
6. Audience headroom: trailing-window reach growth > `d5_reach_growth_max_pct`.
7. Volume floor: window results ≥ `small_sample_min_results`.

**Hard exclusions (defense-in-depth):** not a retargeter (freq < `d3_freq_min`), not saturated (D5), not fatigued (D4), not a kill candidate (D10) or feeder (D2), not CPM-spiking (D8) or EMQ-alarmed (D11), capture-rate ≥ `capture_rate_warn_pct`.
**Why provably safe:** the single condition *freq < 1.3* is strictly below the D3 (2.0) and D5 (4.0) frequency floors, so Scale **mathematically cannot** fire on a "don't-scale" or "saturated" ad.
**Action:** recommend +`d13_scale_increment_pct` (+25%), hold `d13_scale_cadence_days` (3d); if daily spend < `d13_low_spend_daily_eur` → +`d13_aggressive_increment_pct` (+40%). Advisory copy only.

### 5C. Parameter list (45 settings — default; full table in Appendix A)
Economic anchors: `target_cpl_eur` €10 · `target_roas` 3.0 · `deal_cycle_days` 14.
Plus the D1–D14 thresholds, the budget-scaling bands, `rel_roas_baseline` (account_avg), `reporting_window_days` 30, `small_sample_*`, and `capture_rate_warn_pct` 70%. All overridable in the settings UI.

---

## 6. Revenue model
- **Headline revenue = closed value booked by close-month** (A12), labeled "revenue books when deals close — recent spend may not have closed yet," **not** flagged red. Won opps with null `monetary_value` are excluded (not counted as 0) and surfaced ("N closed deals missing value"); null `closed_at` handled explicitly.
- **Per-ad ROAS/CAC** uses the spend↔close join so each ad gets credited for its eventual closes; recent ads (age < `deal_cycle_days`) show the **"maturing"** state.
- Headline (by-close-month) **and** per-ad-joined revenue are both exposed; a June-spend/September-close deal credits the ad's per-ad ROAS while headline books in September.
- No cohort/lead-month restatement (out of scope). All EUR.

---

## 7. Pages

**Page 1 — Overview:** Tier-1 KPI cards, funnel visual (C6: Leads→Booked→1st→2nd→VA→Closed with conv% + drop-off), weekly lead-volume line (C1), spend-vs-revenue-by-close-month bar (C2), audience-segment breakdown (C11). Low-volume context banner + data-trust banner (capture-rate / EMQ).

**Page 2 — Per-Ad table (core):** full table (C5) defaulting to Tier 1 + flags; Top-5 creatives by cost-per-result (up to 5 *gated* ads, with CTR+CPC — C4) above it; row → detail drawer exposing Tier 2/3 + 30-day sparklines + creative thumb + plain-English recommendation; ad/adset/campaign toggle (works for both CBO and ABO campaigns).

**Page 3 — Decision view:** three auto-sorted buckets (C10) — **Scale / Kill-reallocate / Leave-alone** — from the D-flags. Scale = D0; Kill = D10; Leave-alone = default + D2 feeder + D6 niche + D7 + D12 insufficient-data. A feeder never lands in Kill.

**Settings page:** edit any of the 45 thresholds (label, unit, current value, suggested range, "used by" tooltip); inline validation; reset-to-default.

**Design:** dark, clean/editorial, responsive (<960px stack — C3). Header = tenant name + date + range picker (C8/C9).

---

## 8. Database schema *(every table `tenant_id` + RLS; idempotent upsert keys declared)*

```
tenants · users(role) · connections(provider, status, last_completed_date, sync_status, last_error)
ad_accounts(fb_account_id, currency='EUR', timezone_name)
campaigns / adsets / ads(creative_thumb_url, status, budget_level)        -- budget_level: cbo|abo

fb_insights_daily(... UNIQUE(tenant_id, ad_id, date))
  spend, impressions, clicks, link_clicks, ctr, link_ctr, cpc, cpm,
  landing_page_views, video_3s_views, thruplays, fb_leads,
  incremental_conversions_nullable, actions_json
  -- daily reach/frequency kept for single-day sparklines ONLY (non-additive)

fb_insights_window(... UNIQUE(tenant_id, ad_id, window_start, window_end))
  reach, frequency, impressions   -- de-duplicated window reach/frequency from a dedicated /insights call

fb_event_health(... UNIQUE(tenant_id, account_id, event_name, day))  emq_score, checked_at  -- account-level

pipeline_stage_map(ghl_pipeline_id, stage_name, canonical_stage)   -- lead|booked|held_1|held_2|va|won|lost
ghl_contacts(... UNIQUE(tenant_id, ghl_contact_id))
  created_at, fbclid, fb_ad_id, fb_adset_id, fb_campaign_id, attribution_source
ghl_opportunities(... UNIQUE(tenant_id, ghl_opp_id))
  contact_id, pipeline_id, stage, stage_changed_at, monetary_value, status, created_at, closed_at
  -- closed_at drives close-month revenue; stage_changed_at drives last-write-wins

audience_segment_daily(... UNIQUE(tenant_id, ad_id, date, segment))  spend, results   -- new|engaged|existing
ad_status_history(tenant_id, ad_id, status, changed_at)                               -- D14; RLS-scoped like every table

setting_definitions(key PK, label, value_type, unit, default_value, suggested_min, suggested_max, enum_options, used_by)
tenant_settings(tenant_id, key, value, updated_by, updated_at, PRIMARY KEY(tenant_id, key))
effective_settings(view)  -- coalesce(tenant override, default) per tenant × key
```

View **`joined_performance`**: per ad per range → spend + FB leads + GHL-attributed funnel + derived CPL, conv-rate, cost/meeting, CAC, ROAS (+ maturing flag) + diagnostics + flag inputs, **all thresholds resolved from `effective_settings`**. Exposes both by-close-month (headline) and per-ad-joined (ROAS) revenue. All sync writes are idempotent upserts; FB backfill + GHL reconcile resume from `connections.last_completed_date`. Index every `tenant_id`, join column (`ad_id`, `contact_id`, `fb_ad_id`), RLS column.

---

## 9. Multi-tenant + onboarding
1. Sign-up → tenant + owner user; `tenant_settings` empty (runs on defaults via `effective_settings`).
2. Connect Facebook → token in Vault; **Ad Account ID + timezone stored explicitly**; **assert currency = EUR**, block/flag otherwise.
3. Connect GHL → location key (Vault) → fetch pipelines → **map stages** to canonical → **verify the 4 attribution custom fields exist AND probe that they populate** (capture-rate) → assert GHL deal currency is EUR.
4. First sync = historical backfill (idempotent, resumable), then cron.
5. RLS everywhere: user routes = anon key + JWT; sync jobs = service role.

---

## 10. Facebook API setup
System User token (long-lived). Scopes: `ads_read`, `ads_management`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`. Ad Account ID explicit. Insights: `GET /v21.0/act_{id}/insights`, `level=ad`, explicit fields, account-timezone `date_start`. **Separately** pull window-level reach/frequency with `time_range` = active window into `fb_insights_window` (reach is non-additive — never sum daily). Tokens in Vault, never git. Idempotent upserts; back off on 613/80004; resume from watermark; ≥15-min cadence.

---

## 11. Build order
1. **Schema + RLS + Vault + settings catalog (seed 45 defaults).** Idempotent upsert keys, `effective_settings` view. Seed yourself as tenant #1.
2. **FB sync (n8n)** → `ads` + `fb_insights_daily` + **`fb_insights_window`** + backfill (resumable). Verify vs Ads Manager (account-tz).
3. **Overview + per-ad table, FB-only** → Tier 1 (FB-derivable) + Tier 2 + all flags not needing GHL, reading from `effective_settings`. **Independently useful — ship here.**
4. **EMQ check** (account banner) + audience-segment pull (C11) + Settings UI.
5. **Landing-page capture** wiring + GHL integration → webhook (last-write-wins) + reconcile + stage-map UI + capture-rate monitor.
6. **`joined_performance` view** → full funnel (A6–A13, C6, CAC, ROAS per ad, close-month revenue, maturing).
7. **Decision view** (C10, Scale rule D0, D10, D14) + flag tuning.
8. **Onboarding polish** for self-serve.

Ship 1–3 first; de-risks the Meta pull before the CRM join.

---

## 12. Acceptance criteria (testable — this is "done")

1. **KPI coverage:** Overview, last 30d → all 14 Tier-1 metrics (A1–A13 + Frequency B1) render a number, "insufficient data," or "maturing"; spend matches Ads Manager within rounding, bucketed in the account timezone; all values EUR.
2. **Conversion Rate (A4):** account card = leads ÷ link-clicks; per-ad column = `fb_leads ÷ link_clicks`.
3. **Per-ad table (C5):** every active ad = one row, Tier-1 columns + flags; sort works; ad/adset/campaign toggle re-aggregates for both a CBO and an ABO campaign.
4. **Tier expansion:** drawer reveals Tier 2 + Tier 3 (segments); video metrics only when the ad is video; EMQ shown at account level.
5. **Top-5 creatives (C4):** up to 5 *spend-gated* ads ranked by cost-per-result with CTR + CPC (fewer if fewer qualify).
6. **Frequency flags (D1–D3):** computed from **window** frequency; freq < `d2_freq_max` + high spend → 🟢 feeder; freq ≥ `d3_freq_min` + high ROAS → 🟡 don't-scale.
7. **Fatigue (D4):** freq > `d4_freq_min` + CTR down ≥ `d4_ctr_decline_pct` vs trailing **mean**, persisting ≥ `d4_persist_days`, fires 🔴; a low-volume ad below the impressions/clicks floor is suppressed to "insufficient data."
8. **Soft-metric divergence (D7):** bad-percentile CTR but good CPL → 🔵, not a kill flag.
9. **Insufficient-data gate (D12):** ad below `d12_spend_gate_multiple × target_cpl_eur` → "insufficient data"; default window 30d; small-sample warning visible.
10. **Maturing state:** a recent ad (age < `deal_cycle_days`) with spend but no closes shows "revenue still maturing — €X spend, €0 closed, N opps open" for **ROAS, CAC, and cost-per-meeting** — never a 0 or divide error.
11. **Close-month revenue:** headline bars book to `closed_at` month; a lean month is labeled, not red; a Won opp with null `monetary_value` is excluded and surfaced; null `closed_at` handled.
12. **Funnel (C6):** Leads→Booked→1st→2nd→VA→Closed with conv% between each, per scope.
13. **Attribution join:** a contact with stored `fb_ad_id` increments that ad's Meetings/Held/VA/Closed; a contact with no `fb_ad_id` falls to account-level only, and the UI says so.
14. **Charts:** weekly lead-volume line (C1) + spend-vs-revenue bar (C2) render; stack below 960px (C3).
15. **Audience breakdown (C11):** spend + results split by New/Engaged/Existing.
16. **Decision view correctness (C10):** seeded fixture — a winner appears in **Scale**, a below-target ad with a cheaper reallocation target appears in **Kill-reallocate**, and a D12-gated ad and a D2 feeder appear in **Leave-alone (not Kill)**.
17. **Multi-tenant isolation:** as tenant B, no tenant A rows visible via the app (tested through the client SDK, not the SQL editor).
18. **Token security:** FB + GHL tokens absent from repo and from any non-Vault DB column.
19. **No live-poll:** sync on a ≥15-min schedule; no per-request live Graph calls from the dashboard.
20. **Stage mapping:** changing a tenant's stage names in settings re-labels the funnel without code change.
21. **Late attribution (D14):** a paused ad that later receives a Won conversion within `d14_lookback_days` surfaces a "reactivate?" flag.
22. **Ecom absence:** no checkout/ATC metrics appear anywhere in UI or schema.
23. **Window frequency correctness:** window frequency ≥ max(daily frequency) for any multi-day window, and matches Ads Manager for that window.
24. **EUR guard:** connecting a non-EUR FB ad account or GHL location is rejected/flagged at onboarding; ROAS/CAC are only computed EUR↔EUR.
25. **Capture populate:** a submission carrying `?ad_id=…` produces a `ghl_contacts` row with non-null `fb_ad_id` + `fbclid` within one sync cycle.
26. **Capture-rate monitor:** the health view shows % of last-30d contacts with non-null `fb_ad_id` and warns below `capture_rate_warn_pct`.
27. **Idempotent / resumable sync:** re-running a backfill or reconcile yields zero duplicate rows and unchanged aggregates; after a 613/80004-interrupted sync, resume completes with no missing dates and spend still matches Ads Manager.
28. **Per-flag tests:** seeded positive + negative cases fire/suppress D5, D6, D8, D10, and the D11 account banner correctly.
29. **Cross-month credit:** an ad with June spend and a September-closed attributed deal credits that ad's per-ad ROAS while headline revenue books in September.
30. **Webhook ordering:** an out-of-order / replayed GHL stage event does not regress an opportunity's stage (last-write-wins by `stage_changed_at`); a contact with `fbclid` but no `fb_ad_id` → account-level, UI says so.
31. **Settings — defaults:** a new tenant with zero `tenant_settings` rows gets every default via `effective_settings`; all flags compute.
32. **Settings — live tunability:** changing a setting (e.g. `target_cpl_eur` 10 → 25) changes dependent flag/gate output on the next read with no redeploy; deleting the override reverts to default.
33. **Settings — validation:** an out-of-range or wrong-typed value is rejected by the validation trigger.
34. **Scale non-contradiction:** an ad at frequency ≥ `d3_freq_min` can never receive the Scale badge (asserts the §5B guarantee on a seeded fixture).
35. **Budget guidance (D13):** a Scale-flagged ad shows the +`d13_scale_increment_pct` recommendation at the `d13_scale_cadence_days` cadence; the +`d13_aggressive_increment_pct`/double path appears when campaign daily spend < `d13_low_spend_daily_eur`; and a budget-misallocation warning fires when the highest-rel-ROAS campaign does not hold the highest budget.

---

## 13. Failure modes to avoid
Poll live → rate-limited. Sum daily reach for window frequency → wrong (non-additive) → mis-fires every freq flag. Non-idempotent backfill → double-counted spend, broken AC1. Verify capture fields exist but not that they populate → silent account-level degradation. Hardcode thresholds → can't tune per tenant. Miss `fb_ad_id` at lead creation → per-ad funnel impossible. Trust FB conversions over CRM → wrong numbers. Hard-code stage names → breaks per tenant. Un-indexed RLS columns → slow. Show CPL/ROAS below spend gate → misleading. Auto-kill from flags → wrong. Assume non-EUR currency leaks in unchecked. Treat pause as final → miss late attribution. Kill a feeder because ROAS looks low → account collapses. Read recent-ad "maturing" ROAS as failure → kill a fine ad before its deals close.

---

## Appendix A — Full settings table

| Key | Default | Unit | Range | Used by |
|---|---|---|---|---|
| target_cpl_eur | 10 | EUR | 3–100 | all cost-per-result tests, every spend gate |
| target_roas | 3.0 | ratio | 2–6 | Scale rule (mature-ROAS branch) |
| deal_cycle_days | 14 | days | 7–120 | maturing state, cross-month credit, Scale branch |
| d1_freq_prospecting_max | 1.3 | ratio | 1.0–1.6 | D1, D10 gate, Scale eligibility |
| d1_freq_retargeting_min | 2.0 | ratio | 1.6–3.0 | D1 banding |
| d2_spend_share_min_pct | 15 | % | 10–30 | D2 feeder |
| d2_rel_roas_max | 0.8 | ratio | 0.3–1.0 | D2 feeder |
| d2_freq_max | 1.5 | ratio | 1.3–2.0 | D2 feeder |
| rel_roas_baseline | account_avg | enum | account_avg \| adset_avg | D2, D10, Scale |
| d3_roas_min | 1.5 | ratio | 1.0–5.0 | D3 |
| d3_freq_min | 2.0 | ratio | 1.8–3.0 | D3, Scale exclusion |
| d4_freq_min | 3.0 | ratio | 2.5–4.0 | D4, Scale exclusion |
| d4_ctr_decline_pct | 25 | % | 15–40 | D4 |
| d4_trailing_window_days | 7 | days | 3–30 | D4 baseline |
| d4_min_impressions | 1000 | count | 500–3000 | D4 volume floor |
| d4_min_clicks | 30 | count | 5–200 | D4 volume floor |
| d4_persist_days | 2 | days | 1–4 | D4 persistence |
| d5_reach_growth_max_pct | 5 | % | 3–10 | D5, Scale headroom |
| d5_freq_min | 4.0 | ratio | 3.5–6.0 | D5, Scale exclusion |
| d5_trailing_window_days | 7 | days | 7–14 | D5 window |
| d6_spend_share_max_pct | 5 | % | 2–10 | D6 |
| d6_cpr_ratio_max | 1.0 | ratio | 0.5–2.0 | D6, Scale cost gate |
| d7_cpr_ratio_max | 1.0 | ratio | 0.5–2.0 | D7 |
| d7_ctr_percentile_max | 25 | % | 10–50 | D7 |
| d8_cpm_spike_multiple | 2.0 | ratio | 1.5–3.0 | D8, Scale exclusion |
| d8_baseline_window_days | 14 | days | 7–30 | D8 baseline |
| d8_min_impressions_day | 500 | count | 200–2000 | D8 thin-day filter |
| d8_min_history_days | 7 | days | 5–14 | D8 min history |
| d10_spend_gate_multiple | 5 | count | 3–10 | D10 kill gate |
| d10_below_target_margin_pct | 20 | % | 0–100 | D10 below-target |
| d10_realloc_better_margin_pct | 20 | % | 5–100 | D10 reallocation test |
| d11_emq_min | 9 | score | 6–10 | D11 banner, Scale exclusion |
| d12_spend_gate_multiple | 4 | count | 3–5 | D12 gate, Scale precondition |
| d12_adset_min_days | 7 | days | 5–14 | D12 learning, Scale precondition |
| d12_adset_day_floor | 3 | days | 2–5 | D12 floor |
| d13_scale_increment_pct | 25 | % | 20–30 | D13, Scale action |
| d13_scale_cadence_days | 3 | days | 2–4 | D13, Scale action |
| d13_aggressive_increment_pct | 40 | % | 30–100 | D13 aggressive |
| d13_low_spend_daily_eur | 1000 | EUR | 200–2000 | D13 threshold |
| d13_allow_double_below_low_spend | true | boolean | — | D13 doubling |
| d14_lookback_days | 30 | days | 7–120 | D14 reactivate |
| reporting_window_days | 30 | days | 7–90 | all windowed metrics |
| small_sample_warnings_on | true | boolean | — | small-sample logic master toggle |
| small_sample_min_results | 5 | count | 3–30 | small-sample, Scale floor |
| capture_rate_warn_pct | 70 | % | 50–90 | capture monitor, Scale exclusion |
