/**
 * Slack posting + in-place editing for the website-audit flow — routed THROUGH n8n so it reuses the
 * same Slack bot credential already connected there (no bot token is stored in the dashboard).
 *
 * Workflow "Miraside - Audit → Slack" (webhook /webhook/miraside-audit-slack):
 *   { mode: "post",   channel, text }      → posts the message, returns its ts
 *   { mode: "update", channel, ts, text }  → edits that same message in place
 * Best-effort; never throws (callers degrade gracefully on { ok:false }).
 */

/** Appointment Setting channel id (where lead/audit notifications go). Overridable via env. */
export function auditChannel(): string {
  return process.env.SLACK_AUDIT_CHANNEL || "C0B9345NWTU";
}

async function callAudit(payload: Record<string, unknown>): Promise<{ ok: boolean; body: any; error?: string }> {
  const url = process.env.N8N_AUDIT_WEBHOOK_URL;
  if (!url) return { ok: false, body: {}, error: "N8N_AUDIT_WEBHOOK_URL not set" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body: any = await res.json().catch(() => ({}));
  // n8n responds 5xx if the Slack node errored; otherwise the Slack node output (which carries ok/ts/channel).
  if (!res.ok) return { ok: false, body, error: `n8n ${res.status}` };
  return { ok: body?.ok !== false, body };
}

export async function slackPost(channel: string, text: string): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }> {
  try {
    const r = await callAudit({ mode: "post", channel, text });
    if (!r.ok) return { ok: false, error: r.error || "post failed" };
    const b = r.body ?? {};
    const ts: string | undefined = b.message_timestamp ?? b.message?.ts ?? b.ts;
    return { ok: true, ts, channel: b.channel ?? channel };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function slackUpdate(channel: string, ts: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await callAudit({ mode: "update", channel, ts, text });
    if (!r.ok) return { ok: false, error: r.error || "update failed" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
