import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedLead } from "./leads";
import { prettyAnswer } from "./ghl-write";

/**
 * Forward a completed Meta instant-form lead to the audit project's intake endpoint
 * (POST https://miraside.co/api/audit-intake), which generates the ROI audit and emails it — the same
 * pipeline the /audit landing page uses. The audit project never touches Meta; we own attribution/CRM.
 *
 * Contract (2026-07-07):
 * - Auth: `x-audit-token` header (AUDIT_INTAKE_TOKEN — shared secret from the audit project).
 * - Body: { lead_id, language, name, email, phone?, answers: [{question, answer}] } — answers as display
 *   strings in the form's language (they map wording → IDs on their side; if a form question is ever
 *   reworded, tell the audit project so the mapping is updated).
 * - Idempotent on lead_id (their DB unique index): a repeat POST returns the existing audit, never a
 *   second generation/email — so our durable retries and webhook redeliveries are safe.
 * - Response: { ok, slug, audit_url, deduped } · 401 bad token · 422 bad payload · 5xx transient.
 *
 * Best-effort by design: returns {ok:false} rather than throwing; the caller leaves audit_pushed_at
 * null so the scheduled sync retries recent leads (mirrors the ghl_pushed_at pattern).
 */
export type AuditIntakeResult = { ok: true; auditUrl: string | null; deduped: boolean } | { ok: false; error: string };

const INTAKE_URL = () => process.env.AUDIT_INTAKE_URL || "https://miraside.co/api/audit-intake";

export function auditIntakeConfigured(): boolean {
  return !!process.env.AUDIT_INTAKE_TOKEN;
}

/**
 * Which Meta form_ids are designated AUDIT forms — i.e. lead_form_templates the operator flagged `is_audit`
 * (a switch in the form builder) that have been launched, so their `meta_form_id` is minted. Only these
 * forward to the audit intake; every other form (a generic lead-gen qualifier, anything built in Ads Manager)
 * is skipped, so a form the audit project can't map never earns a 422 "No answers could be mapped". Default:
 * none flagged → forward NOTHING until a form is explicitly switched on.
 */
export async function getAuditFormIds(admin: SupabaseClient, tenantId: string): Promise<Set<string>> {
  const { data } = await admin
    .from("lead_form_templates")
    .select("meta_form_id")
    .eq("tenant_id", tenantId)
    .eq("is_audit", true)
    .not("meta_form_id", "is", null);
  return new Set((data ?? []).map((r: { meta_form_id: string | null }) => r.meta_form_id).filter((x): x is string => !!x));
}

/** Whether a lead's form is a designated audit form. Pass the set from getAuditFormIds (fetched once per run). */
export function auditFormAllowed(formId: string | null | undefined, auditFormIds: Set<string>): boolean {
  return !!formId && auditFormIds.has(formId);
}

export async function pushLeadToAuditIntake(
  lead: NormalizedLead,
  // Callers pick their latency budget. The realtime webhook must stay FAST (Meta re-delivers a slow
  // webhook — that redelivery is itself a failure trigger), so it uses a single short attempt; the
  // scheduled sync IS the retry mechanism and can afford a longer window.
  opts: { attempts?: number; timeoutMs?: number } = {}
): Promise<AuditIntakeResult> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const token = process.env.AUDIT_INTAKE_TOKEN;
  if (!token) return { ok: false, error: "not configured (AUDIT_INTAKE_TOKEN)" };

  const body = {
    source: "instant_form", // accepted-and-ignored today; explicit for future multi-source routing
    lead_id: lead.metaLeadId,
    language: "pt", // single PT form for now — flip to a form_id→language map if an EN form ever ships
    name: lead.fullName ?? "",
    email: lead.email ?? "",
    ...(lead.phone ? { phone: lead.phone } : {}), // phone is optional on their side
    // Verbatim display strings (prettyAnswer un-slugs Meta's under_scored multiple-choice values —
    // the same normalization the CRM/Slack pipeline shows).
    answers: lead.answers.map((a) => ({ question: a.label, answer: prettyAnswer(a.value) })),
    ad: { ad_id: lead.fbAdId, adset_id: lead.fbAdsetId, campaign_id: lead.fbCampaignId },
  };

  // Retries only transient failures (5xx / network / timeout). 401/422 are permanent — retrying can't help.
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(INTAKE_URL(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-audit-token": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        // STRICT contract check: a 2xx must carry the documented JSON ({ok:true, audit_url,...}). A 2xx
        // that isn't (e.g. the site's HTML 404 page when the route isn't deployed) is a FAILURE — treating
        // it as success would stamp audit_pushed_at and silently lose the audit forever (never retried).
        const j: any = await res.json().catch(() => null);
        if (j && j.ok === true) {
          return { ok: true, auditUrl: typeof j.audit_url === "string" ? j.audit_url : null, deduped: !!j.deduped };
        }
        lastErr = `audit-intake 2xx without contract body (route missing/misdeployed?): ${j ? JSON.stringify(j).slice(0, 150) : "non-JSON response"}`;
        return { ok: false, error: lastErr }; // permanent-shaped — retrying the same deploy won't change it; the sync re-tries later anyway
      }
      const text = await res.text().catch(() => "");
      lastErr = `audit-intake ${res.status}: ${text.slice(0, 200)}`;
      if (res.status < 500) return { ok: false, error: lastErr }; // 401/422 — don't retry a permanent rejection
    } catch (e: any) {
      lastErr = e?.name === "TimeoutError" ? `audit-intake timeout after ${timeoutMs}ms` : (e?.message ?? String(e));
    }
  }
  return { ok: false, error: lastErr || "audit-intake failed" };
}
