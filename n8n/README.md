# n8n — scheduled Facebook sync

Automates the Meta → Supabase pull so you don't have to run `npm run sync:fb` by hand.
The workflow is just a **scheduler + alerter**: it POSTs to the app's sync endpoint on a
cadence, and the actual sync logic lives in one place (`lib/sync/facebook.ts`), called by
both the CLI and the route — no duplicated logic to drift out of sync.

```
Schedule (every 30 min) ──▶ POST {APP_URL}/api/sync/facebook  ──┬─ ok ─▶ (done)
                            x-sync-token: <SYNC_TRIGGER_SECRET>  └─ err ▶ ALERT
```

## ⚠️ Reachability — read first

n8n (`https://n8n.miraside.co`) is on the public internet; it **cannot reach `localhost:3000`**.
The scheduled sync only succeeds once the app has a **public URL**:

- **After deploy** (Vercel etc.): point the workflow at the deployed URL. This is the intended setup.
- **Before deploy**, to run it now, either:
  - run a tunnel to localhost (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and use that URL, **or**
  - skip n8n for now and use a local scheduler on your Mac (a `launchd` plist running `npm run sync:fb`). Ask Claude to set this up if you want sync working today.

## Import + configure

1. In n8n: **Workflows → Import from File** → `facebook-sync.workflow.json`.
2. Open **POST /api/sync/facebook** and set the URL (replace `REPLACE-WITH-DEPLOYED-APP-URL`).
3. Provide the secret the route checks (it's in the app's `.env` as `SYNC_TRIGGER_SECRET`). Either:
   - set `SYNC_TRIGGER_SECRET` in the **n8n instance env** (the node reads `{{ $env.SYNC_TRIGGER_SECRET }}`), or
   - replace that expression with the literal value / a **Header Auth** credential (`x-sync-token`).
4. (Optional) Replace the **ALERT** NoOp with a Slack/email node so a failed sync notifies you.
5. **Activate** the workflow.

## Notes

- **Auth:** the route is open on `localhost` (dev) and **fail-closed in production** — it requires the
  `x-sync-token` header to equal `SYNC_TRIGGER_SECRET`, or returns 401.
- **Cadence:** 30 min by default (plan calls for ≥15 min; Meta throttles aggressive polling).
- **Payload:** `{ "backfillDays": 14, "windowDays": 30 }` — a rolling re-sync. Upserts are idempotent,
  so re-running never double-counts; recent days self-heal. For a full historical re-pull, POST
  `{ "backfillDays": 90 }` once (or just run `npm run sync:fb`).
- **Reconciliation:** the sync doesn't only upsert — it also **deletes** local campaigns/ad sets/ads
  that no longer exist on Meta (FK cascade). So if you turn an ad off or delete it in Meta, the
  dashboard reflects that on the next run instead of showing a stale "on" row.
- **Errors:** a non-2xx (e.g. Meta 613/80004 rate limit → 502) routes to the ALERT branch; the next
  scheduled run retries from the watermark.
