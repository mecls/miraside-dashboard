import { NextResponse, after } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { launchRowsFromPaths } from "@/lib/launch";
import { BATCH_SIZE, BATCH_INTERVAL_MS, MAX_STALLS, sleep, friendlyError, triggerProcess } from "@/lib/launch-batch";

export const runtime = "nodejs";
export const maxDuration = 300;

function secretOk(got: string, expected: string): boolean {
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Drain ONE batch of a pending batched launch, then re-trigger itself for the next. Called by the launch
 * route (after batch 1) and by each batch after it. It waits (inside after()) until the batch is due, so
 * Meta's Development-tier rate-limit score has recovered. Shared-secret auth. Everything stays PAUSED.
 */
export async function POST(req: Request) {
  const secret = process.env.SYNC_TRIGGER_SECRET;
  if (!secret || !secretOk(req.headers.get("x-launch-secret") ?? "", secret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_next_launch_batch");
  const job: any = Array.isArray(data) ? data[0] : data;
  if (error || !job) return NextResponse.json({ ok: true, idle: true });

  after(async () => {
    const cleanup = (paths: string[]) => (paths.length ? admin.storage.from("launch-media").remove(paths).then(() => {}, () => {}) : Promise.resolve());
    try {
      const pending = job.pending || {};
      const rows: any[] = Array.isArray(pending.rows) ? pending.rows : [];
      if (!rows.length) {
        await admin.from("ad_launches").update({ status: "PAUSED", pending: null }).eq("id", job.id);
        return;
      }

      // Wait until this batch is due (so the rate-limit score has recovered since the previous batch).
      const waitMs = Math.max(0, new Date(pending.nextAt || 0).getTime() - Date.now());
      if (waitMs > 0) await sleep(Math.min(waitMs, 250_000));

      // The user may have cancelled while we were waiting — cancelling clears `pending` (and moves the
      // record off LAUNCHING). Re-check before doing any more work so no further ads get created.
      const cur = await admin.from("ad_launches").select("status, pending, fb_ad_ids").eq("id", job.id).maybeSingle();
      if (!cur.data || (cur.data as any).status !== "LAUNCHING" || !(cur.data as any).pending) return;

      const batch = rows.slice(0, BATCH_SIZE);
      const { result } = await launchRowsFromPaths(admin, job.tenant_id, batch, undefined); // existing-ad-set mode

      // Order-independent: whatever launched (matched by name) is removed; the rest retry next batch.
      const createdNames = new Set(result.created.map((c) => c.name));
      const remaining = rows.filter((r) => !createdNames.has(r.name));
      // Clean up ONLY the images of ads that were actually created. A FAILED row must KEEP its image so a
      // later retry can still find it — deleting a failed batch's images was the bug that made a stalled
      // batch unrecoverable (every retry then hit "No media").
      const pathsOf = (rs: any[]) =>
        Array.from(new Set(rs.flatMap((r) => (Array.isArray(r.imagePaths) ? r.imagePaths : [])).filter((p: any): p is string => typeof p === "string" && !!p)));
      await cleanup(pathsOf(batch.filter((r) => createdNames.has(r.name))));
      // Count ACTUAL Meta creations, not rows removed by name (duplicate names could otherwise overcount) (C16).
      const adCount = (job.ad_count || 0) + result.created.length;
      // Accumulate this batch's ad ids onto the record (never overwrite — earlier batches created ads too),
      // so the sync can roll their live status up into History. Read them off the record, not `job`: the
      // claim RPC's row shape predates this column and wouldn't carry it.
      const prevAdIds = Array.isArray((cur.data as any).fb_ad_ids) ? ((cur.data as any).fb_ad_ids as string[]) : [];
      const adIds = Array.from(new Set([...prevAdIds, ...result.created.map((c) => c.adId)]));
      const madeProgress = result.created.length > 0;
      const stalls = madeProgress ? 0 : (Number(pending.stalls) || 0) + 1;

      if (remaining.length === 0) {
        // Surface under-delivery instead of reporting a clean success: if fewer ads were created than
        // intended, rest at PARTIAL with an explanation rather than PAUSED/last_error=null (C15).
        const total = typeof job.total_ads === "number" ? job.total_ads : null;
        const under = total != null && adCount < total;
        await admin
          .from("ad_launches")
          .update({
            status: under ? "PARTIAL" : "PAUSED",
            ad_count: adCount,
            fb_ad_ids: adIds,
            pending: null,
            last_error: under ? `Only ${adCount} of ${total} ads were created — the rest couldn't be launched.` : null,
          })
          .eq("id", job.id);
        return;
      }
      if (stalls >= MAX_STALLS) {
        await cleanup(pathsOf(remaining)); // giving up — the abandoned rows' images won't be retried
        await admin
          .from("ad_launches")
          .update({ status: "PARTIAL", ad_count: adCount, fb_ad_ids: adIds, pending: null, last_error: friendlyError(result.errors[0]?.error || "Couldn't finish the remaining ads (rate limited).") })
          .eq("id", job.id);
        return;
      }

      // Requeue the rest (lock cleared) and chain the next batch. Guard on status so a cancel that landed
      // during this batch isn't undone by restoring `pending` onto the now-terminal record (C14).
      await admin
        .from("ad_launches")
        .update({ ad_count: adCount, fb_ad_ids: adIds, pending: { rows: remaining, nextAt: new Date(Date.now() + BATCH_INTERVAL_MS).toISOString(), stalls } })
        .eq("id", job.id)
        .eq("status", "LAUNCHING");
      await triggerProcess();
    } catch {
      // Release the lease so a later trigger can retry this job instead of it getting stuck. Only touch a
      // record that is still LAUNCHING with a queue, so this can't resurrect `pending` on a cancelled launch (C14).
      try {
        const fresh = await admin.from("ad_launches").select("pending, status").eq("id", job.id).maybeSingle();
        const p: any = (fresh.data as any)?.pending;
        if (p && p.lock && (fresh.data as any)?.status === "LAUNCHING") {
          delete p.lock;
          await admin.from("ad_launches").update({ pending: p }).eq("id", job.id).eq("status", "LAUNCHING");
        }
      } catch {
        /* ignore */
      }
    }
  });

  return NextResponse.json({ ok: true, processing: job.id });
}
