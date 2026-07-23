import type { NormalizedLead } from "./leads";
import { ghlConfig, ensureField, writeContactWithSource, prettyAnswer } from "./ghl-write";
import { formQuestionLabels } from "./leadform-labels";
import { composeLabel } from "./source";

/**
 * Instant-form pipeline push into GoHighLevel + n8n:
 *   1. ensure a contact-level single-line custom field (in the "ADS" folder) for the ad + each question,
 *   2. upsert the contact by phone with name + every answer in its field + the ad it came from,
 *   3. POST the full structured lead to the n8n webhook → n8n sends Slack (built dynamically).
 *
 * No-op until configured: needs GHL_ADS_FOLDER_ID and N8N_LEAD_WEBHOOK_URL.
 */
export async function pushLeadToGhl(lead: NormalizedLead, opts: { auditUrl?: string | null } = {}): Promise<{ ok: boolean; skipped?: string; contactId?: string }> {
  const c = ghlConfig();
  const n8nUrl = process.env.N8N_LEAD_WEBHOOK_URL;
  if (!c || !c.folder || !n8nUrl) {
    // Surface the misconfiguration instead of silently dropping every lead's GHL+Slack push.
    console.warn("pushLeadToGhl skipped — GHL not configured (need GHL_ADS_FOLDER_ID + N8N_LEAD_WEBHOOK_URL)");
    return { ok: false, skipped: "ghl push not configured" };
  }

  // 1. Build the answer fields + the structured answers for n8n. Instant forms are always Paid Ads.
  // Prefer the form's REAL question text over the label we un-slugged from Meta's key: the key strips
  // accents ("negócio" → "nego_cio"), and that mangled text would become the GHL field name + Slack label.
  const labels = lead.formId ? await formQuestionLabels(lead.formId) : null;
  const answerFields: Array<{ id: string; value: string }> = [];
  const answers: Array<{ question: string; label: string | null; answer: string }> = [];
  for (const a of lead.answers) {
    const value = prettyAnswer(a.value);
    const question = labels?.get(a.key) || a.label;
    answerFields.push({ id: await ensureField(question), value });
    // `question` = full text (GHL field name); `label` = short CRM label for the Slack message.
    answers.push({ question, label: a.shortLabel ?? null, answer: value });
  }

  // 2. Upsert with source (instant form = a Paid Ads conversion; write-once Lead Source + Anúncio).
  const contactId = await writeContactWithSource({
    name: lead.fullName,
    phone: lead.phone,
    email: lead.email,
    website: lead.websiteOverride ?? undefined,
    label: composeLabel("Paid Ads", lead.adName),
    setConversion: true,
    adName: lead.adName,
    extraFields: answerFields,
  });

  // 3. Hand the full lead to n8n (responseMode=lastNode), so a non-OK response means its Slack send failed
  //    → throw so the caller's error alerting surfaces it (the GHL contact is already saved at this point).
  const n8nRes = await fetch(n8nUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contactId,
      name: lead.fullName,
      phone: lead.phone,
      email: lead.email,
      adName: lead.adName,
      adId: lead.fbAdId,
      campaignId: lead.fbCampaignId,
      createdTime: lead.createdTime,
      answers,
      // The generated ROI audit's public URL (from the audit-intake forward), when available — lets the
      // n8n Slack card link straight to the audit. Null until the intake succeeds; harmless if unused.
      auditUrl: opts.auditUrl ?? null,
    }),
  });
  if (!n8nRes.ok) {
    const detail = await n8nRes.text().catch(() => "");
    throw new Error(`n8n lead→Slack notification failed (${n8nRes.status}): ${detail.slice(0, 200)}`);
  }

  return { ok: true, contactId };
}
