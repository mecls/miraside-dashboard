# Source & Conversion Tracking — Miraside

This is the single source of truth for **how we attribute every lead**: where it first came from,
how it converted, where that data lives, and when Meta conversions fire.

> **Status (2026-06-27):** Decisions locked. What's already live vs. still to build is in
> [§11 Implementation status](#11-implementation-status). No UTMs ([§8](#8-utms--not-used)). GHL source
> fields use the combined **`Channel — Detail`** format ([§3](#3-canonical-values--format)).

---

## 1. The one rule (TL;DR)

> **The form tells us the source. If there's an `ad_id`, it's Paid Ads.**
> **Meta conversions fire only for Paid Ads.**

1. **`ad_id` present** → channel **`Paid Ads`** (+ ad name as the detail). **This is the only case Meta fires.**
2. **No `ad_id`** → channel is whatever **the form declares** (`Website`, `LinkedIn`, …). **No Meta event.**

---

## 2. Two fields, two questions

Two separate things on every GoHighLevel contact — never conflate them.

| Field | Question | When written |
|---|---|---|
| **Lead Source** | Where did this contact *first* come from? | **Once**, on first creation. **Never overwritten** (write-once). |
| **Conversion Source** | Which channel drove *this conversion*? | On the **`completed`** stage (the conversion). |

> Example: first replies to a **Cold Email** (Lead Source = `Cold Email`), a month later clicks a Meta
> ad and converts → **Conversion Source = `Paid Ads — …`**, but **Lead Source stays `Cold Email`**.

Both are **plain text fields** holding the combined **`Channel — Detail`** value (§3). The `started`
stage only creates the contact + stamps first-touch Lead Source; **`completed` stamps Conversion
Source.** In parallel, our `leads` DB stores the **clean channel** on its own column (§4).

---

## 3. Canonical values & format

### 3.1 Channel vocabulary (fixed)

```
Paid Ads · YouTube · Instagram · LinkedIn · X (Twitter) · Cold Email · Referral · Website · Direct · Other
```

- **`Paid Ads`** — paid Meta ad (detected by `ad_id`).
- **`YouTube` / `Instagram` / `LinkedIn` / `X (Twitter)`** — organic from that platform.
- **`Cold Email`** — outbound (written by the cold-email tool).
- **`Referral`** — word of mouth (usually manual).
- **`Website`** — homepage audit form (organic site visitor).
- **`Direct`** — a bare landing-page link we sent someone (no ad, no campaign).
- **`Other`** — unknown / doesn't fit.

### 3.2 Strict format (`Channel — Detail`)

```
<Channel> — <Detail>
```

1. Channel **always first**, exactly one of §3.1.
2. Delimiter is **space–em-dash–space** (` — `).
3. **No detail → just the channel**, no delimiter (`Website`, `Direct`).
4. Parse the channel back out by **known-prefix match** (starts-with a §3.1 channel) — robust even if a
   detail contains a dash.

Examples: `Paid Ads — ROI Audit LLA 3%` · `LinkedIn — July €5k Giveaway` · `Website`

---

## 4. `Channel — Detail` in one field, clean charts everywhere

| Where | Stores | Why |
|---|---|---|
| **GoHighLevel** (Lead/Conversion Source) | combined **`Channel — Detail`** | one glance, whole story on the contact |
| **Our `leads` DB** (`channel`, `source_detail`) | the **clean channel** separately | dashboard charts group exactly, zero parsing |

Detail source per channel: **Paid Ads / Instant Form** → the ad name (also in `Anúncio`);
**YouTube / IG / LinkedIn / X** → the form's `source_detail`; **Cold Email** → its campaign;
**Website / Direct / Referral** → usually none.

---

## 5. How each channel is captured

| Channel | How it arrives | Field value | Meta CAPI |
|---|---|---|---|
| **Paid Ads** | Meta ad click → `ad_id` on the URL | `Paid Ads — {ad name}` | ✅ yes (§7) |
| **Instant Form** | Meta native lead form | `Paid Ads — {ad name}` | n/a (Meta-native) |
| **YouTube/IG/LinkedIn/X** | that platform's giveaway page/form | `{Channel} — {giveaway}` | ❌ no |
| **Website** | homepage audit form | `Website` | ❌ no |
| **Direct** | bare /audit link we sent (no `ad_id`) | `Direct` | ❌ no |
| **Cold Email** | outbound funnel | `Cold Email — {campaign}` | ❌ no |
| **Referral** | word of mouth | `Referral — {who}` | ❌ no |

Every giveaway has its **own page + form**, so the form is self-identifying — that's why no UTMs (§8).

---

## 6. What every landing-page parameter is for

| Parameter | Purpose | For source? |
|---|---|---|
| `ad_id` (+ `adset_id`, `campaign_id`) | the paid ad | ✅ Paid Ads signal + ad-name detail |
| `source` | the form's channel | ✅ used when no `ad_id` |
| `source_detail` | the giveaway/campaign | ✅ becomes the detail |
| `qualified` | good-fit gate (team > 20) | ⚠️ Meta-conversion gate only — see §7 |
| `fbclid`, `fbp`, `fbc` | Meta click/cookie ids | ❌ CAPI match data |
| `event_id` | browser↔server dedup key | ❌ CAPI plumbing |
| `page_url` | page they were on | ➖ weak fallback (root → `Website`) |
| `client_ip`, `client_user_agent` | CAPI match quality | ❌ CAPI plumbing |
| `name`/`email`/`phone`/`answers` | the lead | ❌ lead data |

For **source**, only `ad_id` + `source` + `source_detail` matter. The rest is lead data or CAPI fuel.

---

## 7. Meta conversions (CAPI) & the `qualified` field

**Meta conversions fire for `Paid Ads` only** — i.e. when `ad_id` is present. `Direct`, `Website`, and
all organic channels send **nothing** to Meta.

> **Cross-project (landing page):** the /audit browser pixel's **conversion events**
> (`Lead`/`CompleteRegistration`) must be gated the same way — fire only when `ad_id` is present,
> gating on the **same `attr.ad_id` that's sent in the POST body** (URL or persisted), so browser and
> server always agree and dedupe. The server's `isPaidClick` already keys on that body `ad_id`, so the
> dashboard needs no change. **`PageView` stays ungated** (not a conversion; feeds retargeting). The
> persisted `ad_id` should expire on a **~28-day window** (Meta's click window) so stale clicks don't
> over-credit `Paid Ads` forever.

| Stage | Meta event | Trigger |
|---|---|---|
| `started` | `Lead` | Paid Ads only (not gated by `qualified` — unknown yet) |
| the ONE payload flagged `fire_complete_registration: true` (usually a mid-form `progress`) | `CompleteRegistration` | the flag itself — the landing page sets it at the **qualifying moment** (€1M revenue answer = yes) and only when the full gate holds (real ad click + qualified + pixel enabled) |

- **`completed` fires no Meta event.** The conversion moved to the qualifying moment (step 2, mid-form):
  a qualified lead who abandons the rest of the form **still counts** — intended. The server dedupes with
  a single-winner DB claim (`leads.cr_fired_at IS NULL`), so a retried/duplicate flagged POST sends nothing.
- **Dedup:** the browser pixel fires the same event with the same `event_id`; our CAPI sends the flagged
  payload's `event_id` **verbatim** so Meta merges them. We also pass `fbp`/`fbc`/`client_ip`/
  `client_user_agent` + hashed email/phone. (CAPI uses **`fbc`**, not raw `fbclid`.)
- **Why qualify-gate the conversion:** it pushes Meta to optimize toward good-fit leads, not any
  signup. The campaign's optimization event should be set to **`CompleteRegistration`** (a Meta
  *campaign* setting, not dashboard code — costs us nothing either way since we send both events).

### The `qualified` field — read carefully

- It means **revenue €1M+ = yes** (the step-2 question), computed on the website. It no longer triggers
  anything by itself — `fire_complete_registration` is the conversion trigger (the landing page folds
  `qualified` into that flag's gate).
- **It is NOT our CRM qualification.** We already have qualified/unqualified via **GHL tags** (the
  team's manual call, shown in the Leads tab). **Never** write the website `qualified` into
  `leads.qualification` or any GHL qualified/unqualified tag. Different concept, same word.
- The GHL contact is created/updated for **every** lead, qualified or not. The gate touches Meta only.

### Decision matrix

| Incoming | Channel | GHL write | Meta CAPI |
|---|---|---|---|
| `ad_id`, `started` | `Paid Ads — {ad}` | create + first-touch | `Lead` |
| `fire_complete_registration:true` (any stage, once per lead) | `Paid Ads — {ad}` | answers merge as usual | `CompleteRegistration` (payload's `event_id`, once — DB claim) |
| `ad_id`, `completed` (flag false) | `Paid Ads — {ad}` | + Conversion Source | **none** (conversion already fired at the qualifying moment, if it happened) |
| `source:Direct`, no `ad_id` | `Direct` | yes | **none** |
| `source:Website` | `Website` | yes | **none** |
| `source:LinkedIn` (+ detail) | `LinkedIn — {detail}` | yes | **none** |

---

## 8. UTMs — not used

Paid → `ad_id`; organic → the dedicated page/form (its own `source` + `source_detail`). Between them,
100% covered. The four leftover `utm_*` fields in GHL are from GHL's native form tracking — we neither
read nor write them. Ignore. (Only reconsider if we ever send mixed traffic to one shared page.)

---

## 9. The contract: what each form sends

POST to **`/api/leads/website`**:

```jsonc
{
  "stage": "started" | "completed",
  "source": "LinkedIn",                 // homepage → "Website"; /audit → "Direct" (ad_id overrides to Paid Ads)
  "source_detail": "July €5k Giveaway", // omit when none (homepage, direct)
  "qualified": true,                    // team>20; meaningful ONLY on "completed"; gates Meta CR only
  "name": "...", "email": "...", "phone": "...",
  "answers": [ { "question": "...", "answer": "..." } ],   // [] on "started"
  "ad_id": "...", "adset_id": "...", "campaign_id": "...",
  "fbclid": "...", "fbp": "...", "fbc": "...", "event_id": "...",
  "page_url": "...", "client_ip": "...", "client_user_agent": "..."
}
```

| Form | `source` | `source_detail` |
|---|---|---|
| Homepage audit form | `Website` | — |
| /audit ad landing (form-only) | `Direct` *(→ Paid Ads when `ad_id`)* | — *(ad name fills it)* |
| YouTube / IG / LinkedIn / X giveaway | the platform | the giveaway name |

---

## 10. How the dashboard resolves & writes it

### 10.1 Resolve + compose

```
channel = body.ad_id ? "Paid Ads"
        : body.source ? canonical(body.source)
        : isRoot(body.page_url) ? "Website" : "Other"
detail  = body.ad_id ? adName(body.ad_id) : body.source_detail
label   = detail ? `${channel} — ${detail}` : channel
```

### 10.2 GoHighLevel (combined field; write-once Lead Source)

```
upsert contact (Conversion Source = label on "completed"; Anúncio = adName; tags)
if (new contact OR Lead Source empty): set Lead Source = label   # first touch, write-once
```

### 10.3 Our database (clean channel for charts)

```
leads.channel        = channel
leads.source_detail  = detail
leads.audit_qualified = body.qualified   # set on "completed", and set true by the CR claim (the flag certifies it); NOT the CRM qualification
```

### 10.4 Meta CAPI (gated)

```
if channel === "Paid Ads" and stage == "started":   send Lead (eventID = event_id)
if body.fire_complete_registration === true:        # the qualifying moment — the ONLY CR trigger
    claim leads.cr_fired_at (single-winner, IS NULL → set)   # at-most-once per lead
    if claim won:                                   send CompleteRegistration (eventID = event_id, verbatim)
# stage == "completed" sends NOTHING. Direct / Website / organic → nothing.
```

### 10.5 Instant forms

Always from an ad → channel `Paid Ads`, label `Paid Ads — {ad name}`, written to both GHL fields
(Lead Source if empty; Conversion Source always) + `Anúncio`. (`lib/sync/leads.ts` → `lib/ghl-push.ts`.)

### 10.6 Channels we don't own

Cold email, referrals, etc. are written by their own tools / by hand using the §3 strict format.

---

## 11. Implementation status

| Piece | Status |
|---|---|
| `leads.source` / `stage` / Slack columns | ✅ Live |
| `Anúncio` field; endpoint captures `ad_id`/`adset_id`/`campaign_id`; Slack via n8n | ✅ Live |
| `Lead Source` + `Conversion Source` GHL fields (combined) | ⛔ To create |
| `leads.channel` + `source_detail` + `audit_qualified` columns | ⛔ To add |
| Endpoint accepts `source` + `source_detail` + `qualified` | ⛔ To build |
| Resolve/compose + write-once Lead Source | ⛔ To build |
| **CAPI gates: Paid-Ads-only + CR-only-if-qualified** | ⛔ To build (today fires unconditionally) |
| Conversion Source on `completed` only | ⛔ To build |
| Forms send `source`/`source_detail`/`qualified` (other window) | ⛔ To wire |
| /audit browser pixel gated on `ad_id` (other window) | ⛔ To wire |

---

## 12. Operational linchpins

1. **Ad URLs must carry the ad id** — `?ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}`
   on every ad's destination URL, or paid clicks arrive with no `ad_id` and fall back to `Direct`
   (losing the Paid Ads classification, the ad detail, **and** the Meta conversion).
2. **Browser pixel gated on `ad_id`** (other window) — so Direct visits don't leak conversions.
3. **Each form declares its `source`** (+ `source_detail` for giveaways).
4. **Strict format only** — exact §3 channels + ` — ` delimiter.

---

## 13. Future enhancement (not now)

**Conversion Source = booked call.** Today we stamp it at audit `completed` (the conversion the
dashboard sees). If we later want it to reflect the *booked call*, a GHL workflow on "appointment
booked" can refine `Conversion Source` at that moment — forward-compatible, nothing wasted.

---

## 14. Config reference

| Thing | Value |
|---|---|
| GHL location id | `qgJGoCDn5Bha3BAsKtqX` |
| GHL "ADS" custom-field folder | `BWlIPuNNnvJKatTlaNXs` |
| Source field format | `Channel — Detail` (` — ` = space–em-dash–space) |
| Website endpoint | `POST /api/leads/website` |
| Source resolution helper | `lib/source.ts` |
| GHL write helpers | `lib/ghl-write.ts` |
| Instant-form pipeline | `lib/sync/leads.ts`, `lib/ghl-push.ts` |
| Meta CAPI | `lib/meta-capi.ts` |
