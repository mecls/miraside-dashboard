# Landing-page → `/api/leads/website` contract (partial-answer capture)

**Why this exists:** the audit form was losing every answer when a visitor abandoned before the final step,
because answers were only saved on the final `completed` POST. The server is now fixed to **store and merge
answers on every fire** (never dropping earlier ones, atomic under concurrency). But the server can only save
what the landing page **sends** — so the landing page must send the answers-so-far on each step, not just at
the end.

## What the landing page must do

Fire a POST to `/api/leads/website` **as the visitor progresses**, not only at the end:

1. **Step 1 (personal info submitted):** `stage: "started"` — with the contact info and any answers gathered so far.
2. **After each subsequent step / answer:** `stage: "progress"` — with the **cumulative** answers so far.
3. **Final step:** `stage: "completed"` — with the full cumulative answers.

Each POST is the same shape; only `stage` and the growing `answers` array change.

```js
async function sendLead(stage, answersSoFar) {
  await fetch("https://miraside-dashboard.vercel.app/api/leads/website", {
    method: "POST",
    headers: { "content-type": "application/json", "x-lead-token": WEBSITE_LEAD_TOKEN },
    body: JSON.stringify({
      stage,                       // "started" | "progress" | "completed"
      phone: contact.phone,        // REQUIRED and STABLE across every fire (this is the lead's identity)
      email: contact.email,        // send both if you have them
      name: contact.name,
      answers: answersSoFar,       // CUMULATIVE list, [{ question, answer }], resent (growing) on every fire
      // attribution (unchanged):
      ad_id, adset_id, campaign_id, event_id, fbp, fbc, page_url, qualified,
      // conversion trigger: TRUE on exactly ONE payload per lead — the qualifying moment (€1M answer = yes,
      // usually a mid-form "progress" fire). Must carry the SAME event_id the browser pixel used for its
      // CompleteRegistration. False on every other payload. This flag is the ONLY thing that fires the
      // server-side CompleteRegistration — completion no longer does.
      fire_complete_registration,
    }),
  });
}

// step 1:            sendLead("started",  answers.slice(0, done));
// each later step:   sendLead("progress", answers.slice(0, done));   // fire on step change (or debounced on answer change)
// final submit:      sendLead("completed", answers);
```

## Rules that matter

- **Send `answers` on EVERY fire** (started/progress/completed), always the **cumulative** set. If you only send
  them on `completed`, an abandoner is still lost — the server never received them.
- **Keep the identity stable:** send the **same `phone`** (and email) on every fire. The server keys the lead by
  `phone` (falling back to email). If step 1 sends only email and a later step introduces phone, they become two
  separate leads. Collect contact info up front (you already do) and resend it each fire.
- **Cumulative is safest.** The server merges by question, so resending the whole list each time is correct and
  self-healing (a dropped network call is recovered by the next fire). Sending only per-step deltas also works,
  but cumulative is more robust.
- `progress` fires do **not** re-fire the Lead CAPI or re-notify Slack — they only save answers and update the
  existing Slack card in place. Fire them freely. The ONE progress fire carrying `fire_complete_registration: true`
  additionally triggers the server-side CompleteRegistration (see below).

## What the server guarantees (already deployed)

- Answers received on any fire are persisted immediately and **merged** (union by question; incoming value wins;
  an earlier answer is never dropped; an empty `answers` never wipes stored answers).
- The merge is **atomic** (row-locked DB function `merge_website_lead_answers`) — concurrent step fires can't
  clobber each other.
- CompleteRegistration fires **at most once per lead**, triggered ONLY by the payload flagged
  `fire_complete_registration: true` (the qualifying moment — NOT stage completion). The server sends the CAPI
  event with that payload's `event_id` **verbatim** so Meta dedupes it against the browser pixel's event. A
  duplicate/retried POST loses a DB single-winner claim and sends nothing. A qualified lead who abandons after
  qualifying (never sends `completed`) still counts as a conversion — intended.
- `qualified` keeps its meaning (revenue €1M+ = yes) and is still recorded on the lead — it just no longer
  triggers the conversion; the flag does.
- A lead who abandons keeps every answer we were sent, viewable in the Leads CRM.
