/**
 * Facebook -> Supabase sync CLI (full backfill).
 *
 * Thin wrapper around lib/sync/facebook.ts (the shared sync logic the n8n-triggered
 * API route also calls). Builds the service-role client directly because the shared
 * lib/supabase/admin.ts is guarded with `server-only` for the Next bundle.
 *
 * Run: npm run sync:fb
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { runFacebookSync } from "../lib/sync/facebook";

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // CLI does the full historical backfill; the scheduled route uses a short rolling window.
  const s = await runFacebookSync(sb, { backfillDays: 90 });

  console.log(`tenant: Miraside-AI (${s.tenantId})`);
  console.log(`account: ${s.account.name} (${s.account.currency}, ${s.account.timezone}) — today ${s.accountToday}`);
  console.log(`hierarchy: ${s.hierarchy.campaigns} campaigns, ${s.hierarchy.adsets} adsets, ${s.hierarchy.ads} ads`);
  console.log(`daily insights: ${s.rows.daily} rows (${s.range.daily.since}..${s.range.daily.until})`);
  console.log(`window reach: ${s.rows.window} rows (${s.range.window.since}..${s.range.window.until})`);
  console.log(`\n✓ sync complete in ${(s.durationMs / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("SYNC FAILED:", e?.message ?? e);
  process.exit(1);
});
