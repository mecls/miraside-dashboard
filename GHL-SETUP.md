# GoHighLevel Setup — what *you* build, so the revenue half lights up

This is the one thing blocking the revenue side of the dashboard. None of it is code —
it's all done inside GoHighLevel (and, for Phase 2, on your opt-in page). Once you finish
**Phase 1**, tell me and I'll build the GHL→dashboard sync; the Revenue / CAC / ROAS / funnel
numbers then go live. **Phase 2** is optional and can come later — it adds *per-ad* attribution
(which ad made which money), which powers the "Scale / Kill" recommendations.

Everything here matches what the database and the app already expect, so if you follow the
names/mappings below it will drop straight in.

---

## Why two phases

| | What you set up | What lights up | Effort |
|---|---|---|---|
| **Phase 1 — Account-level revenue** | A GHL sales pipeline with € deal values | Revenue, Closed, Meetings, **CAC, ROAS** (whole-account), and the full **funnel** on Overview | ~30 min in GHL |
| **Phase 2 — Per-ad attribution** | 4 hidden fields on your opt-in page + run ads in "Landing page" mode | *Which specific ad* earned the money → the **Scale / Kill** buckets on the Decisions page | More involved |

> Plain-English: Phase 1 answers *"are the ads making money overall?"*. Phase 2 answers
> *"which ad in particular?"*. Phase 1 is the big, easy win — do it first.

---

## PHASE 1 — Account-level revenue (do this first)

### 1. Create / confirm one sales pipeline in GHL
Settings → **Pipelines**. Use (or rename to) stages that match the dashboard's funnel.
You can name them anything — I map your names to the dashboard's stages, so don't worry
about exact wording. A sensible default for a service business:

| Your GHL stage (rename freely) | Dashboard stage it maps to | Shows on funnel as |
|---|---|---|
| New Lead | `lead` | Leads |
| Call Booked | `booked` | Booked |
| 1st Call Held | `held_1` | 1st Held |
| 2nd Call Held | `held_2` | 2nd Held |
| Verbal Agreement | `va` | Verbal |
| Won / Closed | `won` | Won |
| Lost / Disqualified | `lost` | (hidden) |

You don't need all six — map whatever stages you actually use; the rest just show as 0.
When you're done, send me your stage names and I'll fill in the `pipeline_stage_map` (the
table that translates them). Change them later and the funnel re-labels without code changes.

### 2. Put a € value on every deal
- Each opportunity must carry a **monetary value** (the deal size in EUR).
- Revenue is counted **when a deal is marked Won** (that stamps the close date), and it's
  booked to the **month it closed** — so a Won deal with no € amount is *excluded and flagged*
  (not counted as €0). Habit to keep: always fill the value before marking Won.

### 3. Make sure deals are in EUR
The dashboard is EUR-only (no currency conversion). Confirm your GHL account/deal currency is EUR.

### 4. API access (you likely already have it)
Your `GHL_API_KEY` and `GHL_LOCATION_ID` are already in the app's secrets. When I build the
sync I'll test that the key can **read Contacts and Opportunities**. If GoHighLevel has since
moved you to its newer "Private Integration" token, I'll tell you the exact one to generate
(it takes ~1 min: Settings → Private Integrations → new token → tick *Contacts* + *Opportunities*
read scopes) — no guesswork on your end.

**✅ When Phase 1 is done, ping me with your pipeline stage names.** I'll then:
- build the GHL→Supabase sync (mirrors the existing Facebook sync; runs on the same 30-min schedule),
- map your stages, and
- turn the grey "connect GHL" cards into live Revenue / Closed / Meetings / CAC / ROAS + the funnel.

---

## PHASE 2 — Per-ad attribution (later; unlocks Scale / Kill)

This is what lets the dashboard say *"Ad #3 brought in €15k, scale it"* vs *"Ad #5 spends but
never closes, kill it."* It only works for leads that come through a **landing page / opt-in**
(not native Instant Forms), because that's the only place we can read which ad sent the visitor.

### 5. Create 4 contact custom fields in GHL
Settings → **Custom Fields** → add four, type **Single Line / Text**. Name them so the field
key comes out as the left column:

| Field key (what matters) | Suggested field name |
|---|---|
| `fb_ad_id` | FB Ad ID |
| `fb_adset_id` | FB Ad Set ID |
| `fb_campaign_id` | FB Campaign ID |
| `fbclid` | FB Click ID |

### 6. Capture the ad info on your opt-in form
When the dashboard creates an ad in **"Landing page"** mode, it automatically tacks this onto
your URL: `?ad_id=…&adset_id=…&campaign_id=…` (and Facebook adds `fbclid=…`). Your opt-in form
just needs to grab those and save them into the four fields above.

**Easiest way (no code), if your opt-in is a GHL form/funnel:**
1. Add the four custom fields to the form, set each to **Hidden**.
2. On each hidden field, set its **"Query Key"** to the matching URL parameter:

   | Hidden field | Query Key to enter |
   |---|---|
   | FB Ad ID (`fb_ad_id`) | `ad_id` |
   | FB Ad Set ID (`fb_adset_id`) | `adset_id` |
   | FB Campaign ID (`fb_campaign_id`) | `campaign_id` |
   | FB Click ID (`fbclid`) | `fbclid` |

   GHL then auto-fills them from the URL when someone lands and submits. Done.

**If your opt-in page is NOT a GHL form** (a custom site, Webflow, etc.), paste this once into
the page's header and point your hidden inputs at the four field names — it reads the URL,
remembers the values across multi-step funnels, and fills the inputs on submit:

```html
<script>
(function () {
  var map = { ad_id:'fb_ad_id', adset_id:'fb_adset_id', campaign_id:'fb_campaign_id', fbclid:'fbclid' };
  var q = new URLSearchParams(location.search);
  Object.keys(map).forEach(function (param) {
    var v = q.get(param);
    if (v) try { localStorage.setItem(map[param], v); } catch (e) {}
    var saved = (function(){ try { return localStorage.getItem(map[param]); } catch(e){ return null; } })();
    if (saved) {
      var el = document.querySelector('[name="' + map[param] + '"]');
      if (el) el.value = saved;     // hidden <input name="fb_ad_id"> etc.
    }
  });
})();
</script>
```

### 7. Run ads in "Landing page" mode
Use the **Landing page** tab on the dashboard's Create page (not the Instant-form tab) for any
ad you want per-ad revenue on. Instant-form leads still count toward account-level revenue
(Phase 1) — they just can't be traced to a single ad.

**✅ When Phase 2 is done**, I'll wire per-ad ROAS into the Scale / Kill decision buckets and
add a **capture-rate monitor** (warns if fewer than 70% of recent leads carried an ad id —
i.e. the page silently dropped them).

---

## Quick reference — the contract (don't change these names)

- **Funnel canonical stages:** `lead, booked, held_1, held_2, va, won, lost`
- **Contact custom field keys:** `fb_ad_id, fb_adset_id, fb_campaign_id, fbclid`
- **URL params the dashboard appends (landing-page ads):** `ad_id, adset_id, campaign_id` (+ `fbclid` from Facebook)
- **Join key:** `fb_ad_id` (a lead with no `fb_ad_id` → account-level only). `fbclid` is for Meta CAPI, never a join key.
- **Revenue rule:** booked by close month; Won opp with no € value is excluded + surfaced, never counted as €0.

*All of the above is already what the Supabase schema (`ghl_contacts`, `ghl_opportunities`,
`pipeline_stage_map`) and the app code expect — verified live on 2026-06-17.*
