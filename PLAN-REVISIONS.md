# Plan Revisions — Required Changes Before Build

Consolidated from the plan audit (29 verified findings) + the three resolved blocking questions.
Audit verdict was **BLOCK**; this document is the path to clearing it. Nothing here needs a new decision from you — the three decisions below are locked, and every remaining item is a builder instruction with a concrete fix.

**How to use:** Part A = decisions locked. Part B = edits those decisions force. Part C = open findings the builder must fix (priority-ordered). Part D = the full set of acceptance-criteria changes for §11. Part E = suggested order.

---

## Part A — Decisions locked

1. **Currency = EUR, native only.** All money in EUR. Sources must already be EUR (FB ad-account currency *and* GHL deal values). No FX engine is built — enforce EUR at onboarding instead.
2. **"Connect rate" cut.** Remove metric **B11** and flag **D9** entirely. Never intended; no data source.
3. **Lead capture = landing page / opt-in, not native FB instant forms.** Per-ad attribution is therefore *not* automatic — it depends on Facebook URL parameters captured into the form. The per-ad join key is `fb_ad_id`. `fbclid` is CAPI-only, **not** a join key.

---

## Part B — Edits these three decisions force

These resolve 6 audit findings outright (marked ✓ RESOLVED) and rewrite the relevant plan sections.

### B1 — Currency (resolves the two multi-currency findings)
- **§7 schema:** add `timezone_name` and confirm `currency` on `ad_accounts`. No currency column on `ghl_opportunities` and no FX columns — by design.
- **§8 onboarding:** at *Connect Facebook* (step 2), assert `ad_accounts.currency == 'EUR'`; block/flag a non-EUR account with a clear message. Do the same for the GHL location.
- **Naming:** do not call anything "conversion rate" except A4 (leads ÷ link-clicks).
- ✓ RESOLVED: *"Multi-currency has no normalization rule"* (HIGH) and *"ROAS mixes GHL value and FB spend with no normalization"* (MEDIUM).

### B2 — Connect rate (resolves the three connect-rate findings)
- **§4 Tier 2:** delete B11 (Connect rate).
- **§4C:** delete D9 (Connect-rate leak).
- Decision view (Page 3) loses one flag; nothing else depends on it.
- ✓ RESOLVED: *"B11/D9 has no source column"* (HIGH), *"D9 untested"* (MEDIUM), *"connect-rate formula undefined"* (MEDIUM).

### B3 — Landing-page capture (resolves the fbclid-join finding; makes the capture monitor mandatory)
- **§3 rewrite:** the current text says ad IDs *"pass through Lead Ads → custom fields"* — that is the **native instant-form** mechanism and does not apply. Replace with the landing-page path:
  1. **Meta Ads Manager:** each ad's URL-parameters field = `ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}` (Facebook fills macros per ad; appends `fbclid` itself).
  2. **Opt-in page:** JS reads those params on load → hidden form fields; persist to localStorage/cookie so multi-step funnels don't lose them.
  3. **Form → GHL:** hidden fields map to contact custom fields `fb_ad_id`, `fb_adset_id`, `fb_campaign_id`, `fbclid`.
- **Join logic:** per-ad join = `fb_ad_id` (exact) only. **Drop "→ fallback fbclid".** A contact with `fbclid` but no `fb_ad_id` → account-level attribution, with a UI note. `fbclid` is used only to fire Meta CAPI server-side events.
- ✓ RESOLVED: *"fbclid fallback join has no FB-side column"* (MEDIUM). Still requires the capture monitor + populate test (Part C, item 4) and the partial-attribution AC.

---

## Part C — Open findings the builder must fix (priority-ordered)

### 🔴 1. CRITICAL — Multi-day frequency cannot be derived from daily reach
**Problem:** `fb_insights_daily` stores per-day reach, but Meta reach is de-duplicated unique people and is **non-additive across days** — Σ(daily reach) inflates the denominator, so any windowed frequency (default 30d) is understated. A true freq of 4.0 can read ~1.5.
**Impact:** Every frequency flag (D1 funnel position, D2 <1.5, D3 2+, D4 >3.0, D5 >4.0) silently mis-fires; D10 kill candidates get suppressed. AC6/AC7 can't be proven.
**Fix:** Never compute window frequency/reach from daily rows. For each reporting window, issue a dedicated `/insights` call with `time_range` = that window (returns de-duplicated reach + correct frequency). Persist at window grain, e.g. `fb_insights_window(ad_id, window_start, window_end, reach, frequency, impressions)`, or fetch on demand. Restrict daily reach/frequency to single-day sparklines. Budget the extra calls against the §3 rate-limit backoff. *(Also makes D5 "reach plateaued" computable — see item 6.)*

### 🟠 2. HIGH — Sync is not idempotent; partial backfill can't resume
**Problem:** Overlapping writers (GHL webhook + nightly reconcile; FB daily + backfill re-pulling ranges), but §7 declares no PRIMARY KEY/UNIQUE and no upsert; no resume watermark; no gap detection. Meta throttling (613/80004) mid-backfill is expected.
**Impact:** Re-runs double-count; abandoned backfills leave silent date gaps → 30-day spend drifts and **AC1 ("spend matches Ads Manager") silently fails**, taking CPL/CAC/ROAS with it.
**Fix:** Declare upsert keys and `INSERT … ON CONFLICT DO UPDATE`:
- `fb_insights_daily` UNIQUE `(tenant_id, ad_id, date)`
- `audience_segment_daily` UNIQUE `(tenant_id, ad_id, date, segment)`
- `ghl_contacts` UNIQUE `(tenant_id, ghl_contact_id)`
- `ghl_opportunities` UNIQUE `(tenant_id, ghl_opp_id)`
- `fb_event_health` UNIQUE `(tenant_id, account_id, event_name, day)`
Add a per-connection sync watermark (`last_completed_date`, status, last error) to resume + detect gaps; surface last-successful-sync in the UI. *(Webhook ordering: add `stage_changed_at` to `ghl_opportunities` and apply last-write-wins by event timestamp — ignore stage events older than stored.)*

### 🟠 3. HIGH — Decision-support layer: undefined, unmapped, and untested
This is the biggest cluster. Page 3 is the product's differentiator, yet half of it is unprovable.
> ✓ **The "define exact predicates" + "Scale rule" + "flag→bucket mapping" parts are now specified in Part F** (all thresholds made tenant-configurable). What remains here is the *test* work: the per-flag and bucket-correctness acceptance criteria.
**Problems:**
- 7 flags (D5, D6, D8, D10, D11, D15) have **no acceptance criterion** — a build can ship them broken/absent and still pass §11.
- AC16 only checks buckets are *non-empty* + feeders excluded — it never asserts an ad lands in the **correct** bucket. A classifier that's 100% wrong (except the feeder carve-out) passes.
- §4C defines **no positive "Scale" flag** at all, and gives **no flag→bucket mapping**.
- D5 ("reach plateaued") and D15 ("co-moves") have **no numeric definition**; D8 ("CPM > 2× own history") and D2 ("low rel-ROAS") have **no window/baseline**; D8 has no minimum-history guard for new ads.
**Fix:**
1. **Define every flag's exact predicate** in a "flag constants" block in §4C: D8 = CPM > 2× trailing-14d median CPM, min-impressions/day gated, requires ≥7 days history; D2 rel-ROAS = relative to *(account avg / adset avg — pick one)* over the active window; D5 = trailing-7d reach growth < 5% AND freq > 4.0 (uses window reach from item 1); D15 = Pearson ≥ 0.7 between two ads' daily result series over a trailing window.
2. **Define the flag→bucket mapping**, including a positive Scale rule: e.g. `Scale = passes D12 gate + prospecting freq (D1) + rel-ROAS above target + not D3/D5`; `Kill-reallocate = D10 satisfied`; `Leave-alone = default + D2 feeder + D6 niche + D7 + D12 insufficient-data`.
3. **Add one AC per flag** with a positive *and* a negative seeded case (D5, D6, D8, D10, D11, D15).
4. **Strengthen AC16** to assert exact membership against a seeded fixture (winner→Scale, below-target-with-reallocation-target→Kill, gated/feeder→Leave-alone-not-Kill).

### 🟠 4. HIGH — Attribution capture is never tested (now mandatory, per landing-page choice)
**Problem:** The plan only "verifies the custom fields exist; warns if missing" (§3, §8) — that detects an undefined field, not a defined field arriving empty (URL params not wired, multi-step funnel dropping them). AC13 presupposes a contact already has `fb_ad_id`. With landing pages, this is the fragile path and it fails silently.
**Fix:** Add two checks (these are the F4 fix):
- **Populate test:** a submission carrying `?ad_id=…` produces a `ghl_contacts` row with non-null `fb_ad_id` + `fbclid` within one sync cycle (live, or a fixture webhook test posting a realistic payload).
- **Capture-rate monitor:** onboarding/health view shows % of last-30d contacts with non-null `fb_ad_id` and warns below a threshold (e.g. < 70%).

### 🟠 5. HIGH — D4 fatigue fires on low-volume CTR noise (contradicts decision 7)
**Problem:** D4 = "freq > 3.0 AND CTR down > 25% from 7-day **peak**." Daily CTR on low volume is high-variance; a single-click peak day trips it. The freq>3 gate constrains the impressions/reach *ratio*, not absolute volume, so tiny-audience ads still clear it. Contradicts decision 7 and D12. AC7 has no volume guard, so it passes on noise.
**Fix:** Add an impressions/clicks floor below which D4 → "insufficient data"; compare against a 7-day trailing **mean** CTR (pooled clicks ÷ impressions), not the max of 7 daily points; require the decline to persist ≥2 consecutive days; wire the D12 spend gate to D4. Update AC7 to test both firing and low-volume suppression.

### 🟡 6. MEDIUM — Metric & revenue correctness
- **A4 grain mismatch:** per-ad Conversion Rate puts a join-subset (GHL-attributed) numerator over a full-population (FB link_clicks) denominator → biased low. **Fix:** per-ad use `fb_leads ÷ link_clicks` (same FB grain); keep GHL-attributed leads for the account-level card. Pin the definition in §4 / AC2.
- **Null `monetary_value` / `closed_at` on Won opps:** undefined → silently deflates revenue/ROAS or mis-books the month. **Fix:** exclude null-value Won opps from sums (don't count as 0), surface "N closed deals missing value/date," handle null `closed_at`. Add an AC.
- **Cross-month per-ad credit:** §7 requires both close-month headline *and* per-ad-joined revenue, but no AC exercises a June-spend / September-close deal crediting the ad while headline books in September. **Fix:** add that AC.
- **Top-5 creatives vs spend gate:** AC5 demands 5 ranked ads; D12 says sub-gate ads show "insufficient data" — for a low-volume business, often < 5 qualify. **Fix:** reword AC5 to "up to 5 *gated* ads."
- **A7 / A13 maturing:** AC10 tests the "maturing" state only for ROAS, not Cost-per-Meeting (A7) or CAC (A13). **Fix:** extend to all three; guard divide-by-zero on 0 meetings/closes.
- **AC1 timezone:** "spend matches Ads Manager within rounding" is undefined w.r.t. account timezone. **Fix:** add `ad_accounts.timezone_name`; store `fb_insights_daily.date` from the API's account-tz-bucketed `date_start`; state it in AC1.

### ⚪ 7. LOW — Cleanup
- **Orphan IDs:** AC20 references "(F8)" which is defined nowhere; E2/E3/E6 are also orphaned. **Fix:** drop the labels or point them at the backing table (e.g. `pipeline_stage_map`).
- **EMQ grain:** `fb_event_health` is account/event-level but D11 renders as a per-ad badge. **Fix:** surface D11 as an account-scope banner, not a per-row badge.
- **D14 traversal:** detecting "paused ad receives later conversions" needs `ad_status_history` → ad → `ghl_contacts.fb_ad_id` → `ghl_opportunities` (which has only `contact_id`). **Fix:** pin the D14 query semantics in §4C (latest `paused` `changed_at` vs post-pause won `closed_at` via the contact join).

---

## Part D — Acceptance-criteria changes for §11

**Revise existing:**
- **AC1** — add: dates bucketed in account timezone; EUR only.
- **AC2** — pin A4 = leads ÷ link-clicks at account level; per-ad conv-rate = `fb_leads ÷ link_clicks`.
- **AC5** — "up to 5 *gated* ads; fewer if fewer qualify."
- **AC7** — test both D4 firing AND low-volume suppression.
- **AC10** — maturing state for ROAS **and** A7 **and** A13.
- **AC16** — assert *correct* bucket membership against a seeded fixture, not just non-emptiness.
- **AC20** — drop the "(F8)" label.

**Add new:**
- **AC23** Window frequency ≥ max(daily frequency) for any multi-day window; matches Ads Manager for that window.
- **AC24** Non-EUR FB account or GHL location is rejected/flagged at onboarding; ROAS/CAC only computed EUR↔EUR.
- **AC25** A submission with `?ad_id=…` writes non-null `fb_ad_id` to the contact within one sync.
- **AC26** Capture-rate (% of last-30d contacts with non-null `fb_ad_id`) is shown and warns below threshold.
- **AC27** Re-running backfill/reconcile → zero duplicate rows, aggregates unchanged; after an interrupted sync, resume completes with no missing dates and spend still matches Ads Manager.
- **AC28** Per-flag positive+negative tests for D5, D6, D8, D10, D11, D15.
- **AC29** Bucket correctness: winner→Scale, below-target-with-reallocation-target→Kill, gated/feeder→Leave-alone (not Kill).
- **AC30** Cross-month credit: June-spend / Sept-close deal credits the ad's per-ad ROAS while headline books in September.
- **AC31** Won opp with null `monetary_value` excluded (not 0) and surfaced; null `closed_at` handled.
- **AC32** Out-of-order / replayed GHL stage events don't regress an opportunity's stage (last-write-wins by timestamp).
- **AC33** Contact with `fbclid` but no `fb_ad_id` → account-level attribution, UI says so (per decision 3).

---

## Part E — Suggested order

1. **Schema corrections first** (item 2 upsert keys, item 1 window-reach table, EUR/timezone columns) — everything downstream depends on them.
2. **FB-only milestone (plan §10 step 3):** items 1, 5, 6 (FB-derivable parts), plus AC23/AC24/AC27. This stays independently shippable.
3. **Capture + GHL join (§10 steps 5–6):** items 3-data, 4, plus B3 wiring and AC25/AC26/AC33.
4. **Decision view (§10 step 7):** item 3 in full + AC28/AC29.
5. **Cleanup (item 7)** anytime.

The CRITICAL (item 1) and the two HIGHs that corrupt headline numbers (items 2, 4) are the ones that make "Done" unprovable today — clear those and the BLOCK lifts.

---

## Part F — Configurable settings model (resolves "must decide" items 1–3)

**Your directive applied:** *nothing is hardcoded* — every target and threshold is a tenant-settable value with a default. You confirmed two (CPL €10, cycle 14 days); the rest are sensible Meta-media-buying defaults you can override in a settings UI. Tuned conservative for low volume (favor "insufficient data" over a false signal).

### F1 — Storage (3 objects + RLS, fits the existing tenant/RLS/upsert conventions)
- **`setting_definitions`** — global catalog, one row per setting: `key`, `label`, `value_type` (currency/percent/days/ratio/count/enum/boolean), `unit`, `default_value` (jsonb), `suggested_min/max`, `enum_options`, `used_by`. Seeded once; globally readable, service-role-writable.
- **`tenant_settings`** — *sparse* per-tenant overrides: PK `(tenant_id, key)`, `value` jsonb. A row exists **only when a tenant changes a default**. Write = `INSERT … ON CONFLICT (tenant_id,key) DO UPDATE`. A BEFORE-write trigger validates type / range / enum membership, so an out-of-range value can never persist. RLS by `tenant_id`.
- **`effective_settings`** view — `coalesce(override, default)` per tenant × key. Guarantees every tenant has a complete set with zero override rows (a new tenant runs on defaults out of the box; deleting an override cleanly reverts to default).
- **Flags / `joined_performance` read only from `effective_settings`** (pivoted to one row, CROSS JOINed once) — **no literals anywhere**. Cost thresholds resolve as `d6_cpr_ratio_max * target_cpl_eur`; spend gates as `d12_spend_gate_multiple * target_cpl_eur`. Change a setting in the UI → flag output changes on the next read, **no redeploy**.

### F2 — Parameter list (45 settings — default (min–max))

> Patched gap: **`target_roas`** was added — the Scale rule's mature-ROAS branch and D10/D13 reference it, but the draft left it implicit.

**Economic anchors**
- `target_cpl_eur` — **€10** (3–100) → all cost-per-result tests + every spend gate
- `target_roas` — **3.0** (2–6) → Scale mature branch, D10 below-target, D13  *(ADDED)*
- `deal_cycle_days` — **14 days** (7–120) → "still maturing" state, cross-month credit, Scale branch select

**D1 frequency bands** — `d1_freq_prospecting_max` 1.3 (1.0–1.6) · `d1_freq_retargeting_min` 2.0 (1.6–3.0)
**D2 feeder (don't-kill)** — `d2_spend_share_min_pct` 15% (10–30) · `d2_rel_roas_max` 0.8 (0.3–1.0) · `d2_freq_max` 1.5 (1.3–2.0)
**rel-ROAS baseline** — `rel_roas_baseline` `account_avg` (enum: account_avg | adset_avg)
**D3 retargeting (don't-scale)** — `d3_roas_min` 1.5 (1.0–5.0) · `d3_freq_min` 2.0 (1.8–3.0)
**D4 fatigue** — `d4_freq_min` 3.0 (2.5–4.0) · `d4_ctr_decline_pct` 25% (15–40) · `d4_trailing_window_days` 7 (3–30) · `d4_min_impressions` 1000 (500–3000) · `d4_min_clicks` 30 (5–200) · `d4_persist_days` 2 (1–4)
**D5 saturation** — `d5_reach_growth_max_pct` 5% (3–10) · `d5_freq_min` 4.0 (3.5–6.0) · `d5_trailing_window_days` 7 (7–14)
**D6 niche** — `d6_spend_share_max_pct` 5% (2–10) · `d6_cpr_ratio_max` 1.0 (0.5–2.0)
**D7 divergence** — `d7_cpr_ratio_max` 1.0 (0.5–2.0) · `d7_ctr_percentile_max` 25% (10–50)
**D8 CPM spike** — `d8_cpm_spike_multiple` 2.0 (1.5–3.0) · `d8_baseline_window_days` 14 (7–30) · `d8_min_impressions_day` 500 (200–2000) · `d8_min_history_days` 7 (5–14)
**D10 kill/reallocate** — `d10_spend_gate_multiple` 5 (3–10) · `d10_below_target_margin_pct` 20% (0–100) · `d10_realloc_better_margin_pct` 20% (5–100)
**D11 EMQ** — `d11_emq_min` 9 (6–10)  *(account-level banner, per Part C item 7)*
**D12 spend gate** — `d12_spend_gate_multiple` 4 (3–5) · `d12_adset_min_days` 7 (5–14) · `d12_adset_day_floor` 3 (2–5)
**D13 budget scaling** — `d13_scale_increment_pct` 25% (20–30) · `d13_scale_cadence_days` 3 (2–4) · `d13_aggressive_increment_pct` 40% (30–100) · `d13_low_spend_daily_eur` €1000 (200–2000) · `d13_allow_double_below_low_spend` true
**D14 late attribution** — `d14_lookback_days` 30 (7–120)
**Windows / sampling / trust** — `reporting_window_days` 30 (7–90) · `small_sample_warnings_on` true · `small_sample_min_results` 5 (3–30) · `capture_rate_warn_pct` 70% (50–90)

*Not parameters (structural rules, not numbers):* D13 "highest-rel-ROAS campaign holds highest budget" (ranking logic), D14 conversion-count trigger (fires on ≥1 by default), and the D10 reallocation-pool scope (a query decision per AC29).

### F3 — The Scale rule (the positive flag that didn't exist)

**An ad earns the green Scale badge only when it is a data-sufficient, still-fresh *prospecting* ad that beats cost-per-result and out-performs the account, with proven audience headroom.** All conditions read configurable keys.

**Must pass ALL:**
1. **Data-sufficient** (D12): spend ≥ `d12_spend_gate_multiple × target_cpl_eur` (default €40) AND parent adset age ≥ `d12_adset_min_days` — not "insufficient data"/"still learning".
2. **Prospecting-grade reach** (D1): window frequency < `d1_freq_prospecting_max` (1.3) — fresh audience, room to grow.
3. **Cost under target**: cost-per-lead ≤ `d6_cpr_ratio_max × target_cpl_eur` (€10) over the window.
4. **Relative outperformer**: rel-ROAS ≥ 1.0 on `rel_roas_baseline` (account avg).
5. **Maturation-aware ROAS** (the key fix): **if** ad age > `deal_cycle_days` (14) → realized matured ROAS must be ≥ `target_roas` (3.0) AND not still "maturing"; **if younger** → this check is *skipped* and conditions 3–4 carry it (so a long close cycle never blocks a clearly-winning young ad).
6. **Audience headroom**: trailing-window reach growth > `d5_reach_growth_max_pct` (>5%).
7. **Volume floor** (when small-sample warnings on): window results ≥ `small_sample_min_results` (5).

**Hard exclusions (defense-in-depth):** not a retargeter (freq < `d3_freq_min`), not saturated (D5), not fatigued (D4), not a kill candidate (D10) or feeder (D2), not CPM-spiking (D8) or EMQ-alarmed (D11), and account capture-rate ≥ `capture_rate_warn_pct`.

> Why it's provably safe: the single condition *freq < 1.3* is strictly below both the D3 (2.0) and D5 (4.0) frequency floors, so Scale **mathematically cannot** fire on a "don't-scale" or "saturated" ad — the explicit exclusions are redundant belt-and-suspenders.

**Action:** green badge → recommend **+`d13_scale_increment_pct` (+25%), hold `d13_scale_cadence_days` (3 days)**; if campaign daily spend < `d13_low_spend_daily_eur` (€1000) → **+40%** (double only if `d13_allow_double_below_low_spend`). Advisory copy only — never changes budgets.

### F4 — Acceptance criteria to add (settings layer)
- **AC34** A new tenant with zero `tenant_settings` rows gets every default via `effective_settings`; all flags compute.
- **AC35** Changing a setting in the UI (e.g. `target_cpl_eur` 10 → 25) changes the dependent flag/gate output on the next read, with no redeploy; deleting the override reverts to default.
- **AC36** Writing an out-of-range or wrong-typed value (e.g. `d1_freq_prospecting_max` = "abc", or `capture_rate_warn_pct` = 250) is rejected by the validation trigger.
- **AC37** Scale-rule non-contradiction: an ad at frequency ≥ `d3_freq_min` can never receive the Scale badge (asserts the F3 mathematical guarantee on a seeded fixture).
