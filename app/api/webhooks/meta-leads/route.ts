import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getLead } from "@/lib/meta-ads";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { captureLead, claimLeadForPush, releaseLeadPushClaim } from "@/lib/sync/leads";
import { normalizeMetaLead } from "@/lib/leads";
import { ensureShortLabel } from "@/lib/question-labels";
import { resolveMetaAnswers } from "@/lib/leadform-labels";
import { pushLeadToGhl } from "@/lib/ghl-push";
import { pushLeadToAuditIntake, auditFormAllowed, getAuditFormIds } from "@/lib/audit-intake";
import { reportError } from "@/lib/alert";

export const runtime = "nodejs";
// Bound the invocation explicitly: worst case is a multi-lead batched delivery, each lead doing a Meta
// pull + a fast audit forward + the GHL/n8n push. Everything is designed to stay well under this.
export const maxDuration = 120;

/**
 * Realtime Meta leadgen webhook. The moment a lead submits an instant form, Meta calls this — so the
 * lead lands in the Leads tab in seconds AND gets pushed into GoHighLevel with every field populated
 * (which is what lets the GHL workflow fire Slack with the answers already filled in).
 *
 * GET  = Meta's subscription verification handshake (echoes hub.challenge).
 * POST = the lead event; we verify the X-Hub-Signature-256 HMAC before trusting it.
 */
function tokenMatches(got: string | null, expected: string | undefined): boolean {
  if (!got || !expected) return false;
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && tokenMatches(token, process.env.META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(challenge ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

/** Validate Meta's payload signature (HMAC-SHA256 of the raw body with the app secret). */
function validSignature(raw: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!validSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true }); // ack malformed so Meta doesn't retry-storm
  }

  // Collect leadgen ids from the page entries.
  const leadIds: string[] = [];
  if (body?.object === "page" && Array.isArray(body.entry)) {
    for (const e of body.entry) {
      for (const c of e.changes ?? []) {
        if (c.field === "leadgen" && c.value?.leadgen_id) leadIds.push(String(c.value.leadgen_id));
      }
    }
  }

  // Process inline (lead volume is low). ALWAYS ack 200 to Meta — never bounce a failure back at the
  // webhook. Durability instead comes from ghl_pushed_at: captureLead always stores the lead, and a lead
  // whose GHL/n8n push fails is left with ghl_pushed_at=null so the scheduled sync re-pushes it later
  // (retryUnpushedLeads in lib/sync/leads.ts). The alreadyPushed gate stops any duplicate Slack (C29 + C33).
  if (leadIds.length) {
    try {
      const admin = createAdminClient();
      const tenantId = await getPrimaryTenantId();
      if (tenantId) {
        // Forms the operator flagged as audit forms (is_audit + launched) — only these forward to the audit intake.
        const auditFormIds = await getAuditFormIds(admin, tenantId);
        for (const id of leadIds) {
          try {
            // Operator-deleted lead? A Meta redelivery must NOT resurrect it — no re-insert, no audit email,
            // no GHL/Slack. (The sync paths honour lead_exclusions; the webhook must too, or a redelivery
            // that lands after a delete re-runs the whole pipeline for a lead the operator removed.)
            const { data: excluded } = await admin
              .from("lead_exclusions")
              .select("meta_lead_id")
              .eq("tenant_id", tenantId)
              .eq("meta_lead_id", id)
              .maybeSingle();
            if (excluded) continue;

            const raw = await getLead(id);
            if (!raw) continue;
            const { alreadyPushed, auditPushedAt, auditUrl: storedAuditUrl, overrides } = await captureLead(admin, tenantId, raw); // realtime → Leads tab (always stored)
            const parsed = normalizeMetaLead(raw);
            // A redelivered lead may have had its phone/email/name corrected in the Leads tab since first
            // capture — every outbound push must carry the corrections, never Meta's raw values.
            const normalized = {
              ...parsed,
              phone: overrides.phone ?? parsed.phone,
              email: overrides.email ?? parsed.email,
              fullName: overrides.fullName ?? parsed.fullName,
              websiteOverride: overrides.website,
              // Real question/option text for the GHL fields + Slack card (captureLead resolved its own copy).
              answers: await resolveMetaAnswers(parsed.answers, parsed.formId),
            };

            // Forward to the audit project FIRST (it generates + emails the ROI audit — the landing page's
            // pipeline) so the Slack card below can carry the audit link. SINGLE short attempt: the webhook
            // must answer Meta fast (a slow webhook is redelivered — redelivery is itself a failure mode);
            // durability comes from the scheduled sync's retry (audit_pushed_at IS NULL, 6h-bounded), and
            // their endpoint is idempotent on lead_id so an overlap can never email a second audit. Same 6h
            // freshness bound as the sync: a stale redelivery must not retroactively trigger an audit email.
            let auditUrl: string | null = storedAuditUrl;
            const freshEnough =
              !!normalized.createdTime && Date.now() - new Date(normalized.createdTime).getTime() < 6 * 60 * 60 * 1000;
            // Only forward leads from a designated AUDIT form — a generic lead-gen form (e.g. Vedor's reused
            // qualifier) has questions the audit project can't map (422 "No answers could be mapped"), so it
            // must never be forwarded. Empty allowlist → nothing forwards.
            if (!auditPushedAt && freshEnough && auditFormAllowed(normalized.formId, auditFormIds)) {
              const fw = await pushLeadToAuditIntake(normalized, { attempts: 1, timeoutMs: 8_000 });
              if (fw.ok) {
                auditUrl = fw.auditUrl;
                await admin
                  .from("leads")
                  .update({ audit_pushed_at: new Date().toISOString(), audit_url: fw.auditUrl })
                  .eq("tenant_id", tenantId)
                  .eq("meta_lead_id", normalized.metaLeadId);
              } else if (!fw.error.startsWith("not configured")) {
                // Leave audit_pushed_at null — the scheduled sync re-forwards it. Alert without blocking.
                await reportError("Meta lead → audit intake", new Error(fw.error), `lead ${id}`);
              }
            }

            if (alreadyPushed) continue; // already delivered to GHL/Slack — don't duplicate
            // Atomic single-winner claim: two concurrent deliveries (a Meta redelivery racing the first
            // call, or this webhook racing the scheduled retryUnpushedLeads) would otherwise both read
            // ghl_pushed_at=null and both fire Slack. Claiming lets exactly one win; the loser skips.
            const claim = await claimLeadForPush(admin, tenantId, normalized.metaLeadId);
            if (!claim) continue;
            let pushedOk = false;
            try {
              // Enrich each answer with a short CRM-style label (cached) for the Slack notification.
              await Promise.all(
                normalized.answers.map(async (a) => {
                  a.shortLabel = (await ensureShortLabel(admin, tenantId, a.label)) ?? undefined;
                })
              );
              const pushed = await pushLeadToGhl(normalized, { auditUrl }); // realtime → GoHighLevel + n8n (Slack)
              if (pushed.ok) {
                pushedOk = true;
                // The claim already stamped ghl_pushed_at; just attach the discovered contact id so edits /
                // qualification matching don't wait for the next scheduled sync to find it by phone.
                if (pushed.contactId) {
                  await admin
                    .from("leads")
                    .update({ ghl_contact_id: pushed.contactId })
                    .eq("tenant_id", tenantId)
                    .eq("meta_lead_id", normalized.metaLeadId);
                }
              }
            } finally {
              // Release the claim on any non-success (failure or throw) → the scheduled sync retries it.
              if (!pushedOk) await releaseLeadPushClaim(admin, tenantId, normalized.metaLeadId, claim);
            }
          } catch (e: any) {
            console.error("lead processing failed:", id, e?.message ?? e);
            await reportError("Meta lead → GHL pipeline", e, `lead ${id}`);
          }
        }
      }
    } catch (e: any) {
      console.error("meta-leads webhook processing failed:", e?.message ?? e);
      await reportError("Meta lead webhook", e);
    }
  }
  return NextResponse.json({ ok: true }); // always 200 — Meta must never see a failure from us
}
