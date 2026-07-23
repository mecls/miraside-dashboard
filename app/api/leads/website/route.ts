import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { ensureField, writeContactWithSource, prettyAnswer } from "@/lib/ghl-write";
import { resolveChannel, composeLabel, isPaidClick } from "@/lib/source";
import { ensureShortLabel } from "@/lib/question-labels";
import { slackPost, slackUpdate, auditChannel } from "@/lib/slack";
import { sendCapiEvent } from "@/lib/meta-capi";
import { reportError } from "@/lib/alert";

export const runtime = "nodejs";
export const maxDuration = 60;

// CORS: opt-in origin allowlist via WEBSITE_LEAD_ORIGINS (comma-separated). If unset, keep "*" so the
// live landing-page integration is never broken by a blind change — set the env to lock it down.
function corsFor(req: Request): Record<string, string> {
  const allow = (process.env.WEBSITE_LEAD_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin = allow.length === 0 ? "*" : allow.includes(origin) ? origin : allow[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-lead-token",
  };
}

// Best-effort per-instance rate limit (the token is browser-embedded, so treat callers as untrusted).
// Not a hard guarantee across instances, but stops trivial abuse loops from spamming GHL fields / CAPI.
const RL = new Map<string, number[]>();
const RL_WINDOW_MS = 60_000;
const RL_MAX = 30;
function rateLimited(ipKey: string): boolean {
  const now = Date.now();
  const hits = (RL.get(ipKey) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    RL.set(ipKey, hits);
    return true;
  }
  hits.push(now);
  RL.set(ipKey, hits);
  return false;
}
function clientIpKey(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

// Input bounds — the answers/strings are attacker-shaped, and each new question mints a permanent GHL
// field + a paid label call, so cap hard before any side effect.
const MAX_ANSWERS = 30;
const MAX_Q = 300;
const MAX_A = 5000;
const MAX_NAME = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digits = (p?: string | null) => (p ?? "").replace(/\D/g, "");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// One stored answer. The union-merge that preserves partial submissions is done atomically in the DB
// (merge_website_lead_answers RPC) so concurrent per-step fires can't lost-update each other.
type StoredAnswer = { key: string; label: string; value: string };

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsFor(req) });
}

function authorized(req: Request): boolean {
  const expected = process.env.WEBSITE_LEAD_TOKEN;
  if (!expected) return false;
  const got = req.headers.get("x-lead-token") ?? "";
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

interface Body {
  stage?: "started" | "progress" | "completed";
  source?: string;
  source_detail?: string;
  qualified?: boolean;
  // True on exactly ONE payload per lead — the qualifying moment (usually a mid-form "progress" fire, when
  // the prospect answers yes to the €1M question). The landing page sets it only when the full gate holds
  // (real ad click + qualified + pixel enabled), and its browser pixel fired CompleteRegistration with THIS
  // payload's event_id. It is the ONLY trigger for the CAPI CompleteRegistration.
  fire_complete_registration?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  answers?: Array<{ question?: string; answer?: string }>;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  fbp?: string;
  fbc?: string;
  event_id?: string;
  page_url?: string;
  client_ip?: string;
  client_user_agent?: string;
}

async function resolveAdName(admin: SupabaseClient, tenantId: string, adId?: string | null): Promise<string | null> {
  if (!adId) return null;
  const { data } = await admin.from("ads").select("name").eq("tenant_id", tenantId).eq("fb_ad_id", adId).maybeSingle();
  return data?.name ?? adId;
}

const line = (label: string, value?: string | null) => (value ? `*${label}:* ${value}\n` : "");
function startedMessage(ad: string | null, name: string, phone: string, email: string, answers?: string): string {
  // Shows answers-so-far too, so the team can see a partial (abandoned) submission's answers live.
  return (`🟡 *Audit in progress* — ${ad || "ROI Audit"}\n` + line("Name", name) + line("Phone", phone) + line("Email", email) + (answers ? `\n${answers}` : "")).trimEnd();
}
function completedMessage(ad: string | null, name: string, phone: string, email: string, answers: string): string {
  return (`✅ *Audit completed* — ${ad || "ROI Audit"}\n` + line("Name", name) + line("Phone", phone) + line("Email", email) + (answers ? `\n${answers}` : "")).trimEnd();
}

export async function POST(req: Request) {
  const cors = corsFor(req);
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: cors });
  if (rateLimited(clientIpKey(req))) return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429, headers: cors });

  let b: Body;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400, headers: cors });
  }

  // Lifecycle: "completed" is the FINAL step (full record saved; GHL Conversion Source set). Every other fire
  // ("started", "progress", or unspecified) is a NON-final step whose job is to persist/merge answers, so a
  // lead who abandons before the last step keeps everything they already typed. NOTE: the Meta
  // CompleteRegistration conversion is NOT tied to completion — it fires on the payload flagged
  // `fire_complete_registration` (the qualifying moment, usually mid-form; see the CAPI block).
  const isCompleted = b.stage === "completed";
  const phoneDigits = digits(b.phone);
  const emailNorm = (b.email ?? "").toLowerCase().trim();
  if (!phoneDigits && !emailNorm) return NextResponse.json({ ok: false, error: "phone or email required" }, { status: 400, headers: cors });

  // Stable key ties every fire (started → progress… → completed) to the same row + GHL contact.
  const key = `web:${phoneDigits || emailNorm}`;
  // Non-PII reference for the error/alert channel (never the full phone/email).
  const ref = phoneDigits ? `web:***${phoneDigits.slice(-4)}` : "web:email-lead";
  const name = cut((b.name ?? "").trim(), MAX_NAME);
  const answersIn = Array.isArray(b.answers) ? b.answers.slice(0, MAX_ANSWERS) : [];

  // Parse answers on EVERY fire (not just completed). This is the core of not losing partial submissions.
  const incomingAnswers: StoredAnswer[] = [];
  for (const a of answersIn) {
    const question = cut((a.question ?? "").trim(), MAX_Q);
    const value = prettyAnswer(cut((a.answer ?? "").trim(), MAX_A));
    if (!question || !value) continue;
    incomingAnswers.push({ key: "", label: question, value });
  }

  try {
    const admin = createAdminClient();
    const tenantId = await getPrimaryTenantId();
    if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant" }, { status: 400, headers: cors });

    // If an operator permanently deleted this visitor from the Leads tab, don't let a late progress ping
    // resurrect the row (deletion records a durable exclusion keyed by the same web:<phone|email> id).
    const { data: excluded } = await admin
      .from("lead_exclusions")
      .select("meta_lead_id")
      .eq("tenant_id", tenantId)
      .eq("meta_lead_id", key)
      .maybeSingle();
    if (excluded) return NextResponse.json({ ok: true, skipped: "excluded" }, { status: 200, headers: cors });

    const adName = await resolveAdName(admin, tenantId, b.ad_id);
    const now = new Date().toISOString();
    const channel = auditChannel();
    const matchKey = (q: any) => q.eq("tenant_id", tenantId).eq("meta_lead_id", key);

    // --- Attribution: resolve channel + detail → the strict "Channel — Detail" label (SOURCE-TRACKING.md) ---
    const attrChannel = resolveChannel(b);
    const detail = isPaidClick(b) ? adName : b.source_detail ? cut(b.source_detail.trim(), MAX_Q) : null;
    const label = composeLabel(attrChannel, detail);

    // --- Atomic claim: INSERT the lead row FIRST (with whatever answers came in) so it is never lost.
    //     The unique (tenant_id, meta_lead_id) serializes concurrent fires; the first insert "owns" the Slack message. ---
    const baseRow: Record<string, unknown> = {
      tenant_id: tenantId, meta_lead_id: key, source: "website",
      channel: attrChannel, source_detail: detail,
      audit_qualified: isCompleted ? !!b.qualified : null,
      full_name: name || null, email: b.email || null, email_norm: emailNorm || null,
      phone: b.phone || null, phone_norm: phoneDigits || null,
      fb_ad_id: b.ad_id || null, fb_adset_id: b.adset_id || null, fb_campaign_id: b.campaign_id || null,
      ad_name: adName, ghl_contact_id: null, slack_channel: channel, created_time: now, started_at: now, synced_at: now,
    };
    const claimRow: Record<string, unknown> = isCompleted
      ? { ...baseRow, stage: "completed", completed_at: now, answers: incomingAnswers }
      : { ...baseRow, stage: "started", answers: incomingAnswers };

    const { error: insErr } = await admin.from("leads").insert(claimRow).select("id").maybeSingle();
    if (insErr && insErr.code !== "23505") throw new Error(`leads claim insert: ${insErr.message}`);
    const isFirst = !insErr; // false => row already existed (a prior fire claimed it)

    // Merge incoming answers with what's already stored (union — never drops an earlier answer). Done in an
    // ATOMIC, row-locked DB function so two concurrent per-step fires can't lost-update each other's answers.
    // Returns (and persists) the fullest set so far — what we push to GHL and show in Slack.
    let effectiveAnswers = incomingAnswers;
    if (!isFirst) {
      const m = await admin.rpc("merge_website_lead_answers", { p_tenant: tenantId, p_key: key, p_incoming: incomingAnswers });
      if (m.error) {
        // RPC unavailable/failed — fall back to a best-effort read-union-write so answers are NEVER silently
        // lost (the RPC is the atomic path; this fallback still persists, just without the row lock).
        console.error("website lead answer merge RPC failed, falling back:", m.error.message);
        await reportError("Website audit → answer merge", m.error, ref);
        const cur = (await matchKey(admin.from("leads").select("answers")).maybeSingle()).data as { answers?: StoredAnswer[] } | null;
        const seen = new Map<string, StoredAnswer>();
        for (const a of Array.isArray(cur?.answers) ? cur!.answers : []) if (a?.label) seen.set(a.label.trim().toLowerCase(), a);
        for (const a of incomingAnswers) if (a?.label) seen.set(a.label.trim().toLowerCase(), a);
        effectiveAnswers = Array.from(seen.values()).slice(0, MAX_ANSWERS);
        const { error: werr } = await matchKey(admin.from("leads").update({ answers: effectiveAnswers, synced_at: now }));
        if (werr) await reportError("Website audit → answer fallback write", werr, ref);
      } else if (Array.isArray(m.data)) {
        effectiveAnswers = m.data as StoredAnswer[];
      }
    }

    // Operator corrections (Leads tab) must survive later stage fires — re-pushing the visitor-typed
    // values would revert a corrected phone/email/name on the GHL contact (the upsert writes them all).
    // Only possible after the first fire: the row didn't exist before it, so no overrides could either.
    let pushName: string | null = name || null;
    let pushPhone = b.phone;
    let pushEmail = b.email;
    let pushWebsite: string | undefined;
    if (!isFirst) {
      const { data: ov } = await matchKey(
        admin.from("leads").select("phone_override, email_override, first_name_override, last_name_override, website_override")
      ).maybeSingle();
      if (ov) {
        const ovName = [ov.first_name_override, ov.last_name_override].filter(Boolean).join(" ");
        pushPhone = ov.phone_override ?? pushPhone;
        pushEmail = ov.email_override ?? pushEmail;
        pushName = ovName || pushName;
        pushWebsite = ov.website_override ?? undefined;
      }
    }

    // --- GHL (best-effort): push the FULL current answer set so the contact fills in as the lead progresses.
    //     A GHL failure must never lose the lead (already persisted) nor 500 the request. ---
    let ghlContactId: string | null = null;
    try {
      const answerFields: Array<{ id: string; value: string }> = [];
      for (const sa of effectiveAnswers) answerFields.push({ id: await ensureField(sa.label), value: sa.value });
      const tag = isCompleted ? "audit-completed" : "audit-started";
      ghlContactId = await writeContactWithSource({
        name: pushName,
        phone: pushPhone,
        email: pushEmail,
        website: pushWebsite,
        label,
        setConversion: isCompleted, // Conversion Source only on the conversion
        adName,
        extraFields: answerFields,
        tags: [tag],
      });
    } catch (e: any) {
      console.error("website lead GHL push failed:", e?.message ?? e);
      await reportError("Website audit → GHL", e, ref);
    }

    // Persist the completion transition / GHL link onto the existing row (answers were already written
    // atomically by the merge RPC above; the first fire stored its answers via the insert). The completion
    // transition is guarded with `.neq(stage,"completed")` so ONLY the fire that actually flips started→completed
    // matches — a repeated "completed" POST updates nothing. (This no longer gates any CAPI event: the
    // CompleteRegistration conversion fires on the `fire_complete_registration` flag, in the CAPI block below.)
    let transitionedToCompleted = false;
    if (!isFirst && isCompleted) {
      const upd: Record<string, unknown> = { stage: "completed", completed_at: now, audit_qualified: !!b.qualified, ad_name: adName, channel: attrChannel, source_detail: detail, synced_at: now };
      if (ghlContactId) upd.ghl_contact_id = ghlContactId;
      const { data: rows, error } = await matchKey(admin.from("leads").update(upd)).neq("stage", "completed").select("id");
      if (error) await reportError("Website audit → lead update", error, ref);
      transitionedToCompleted = Array.isArray(rows) && rows.length > 0;
      if (!transitionedToCompleted && ghlContactId) {
        // Already completed by a prior fire — still make sure the GHL link is stored.
        await matchKey(admin.from("leads").update({ ghl_contact_id: ghlContactId }));
      }
    } else if (ghlContactId) {
      const { error } = await matchKey(admin.from("leads").update({ ghl_contact_id: ghlContactId }));
      if (error) await reportError("Website audit → lead update", error, ref);
    }

    // Short CRM-style labels for the Slack message (best-effort; falls back to the raw question).
    const answerLines: string[] = [];
    for (const sa of effectiveAnswers) {
      const short = (await ensureShortLabel(admin, tenantId, sa.label).catch(() => null)) ?? sa.label;
      answerLines.push(`*${short}:* ${sa.value}`);
    }
    const answersText = answerLines.join("\n");
    const mkText = (completed: boolean) =>
      completed
        ? completedMessage(adName, name, b.phone ?? "", b.email ?? "", answersText)
        : startedMessage(adName, name, b.phone ?? "", b.email ?? "", answersText);

    const reportSlack = (where: string, e: string) => reportError(`Website audit → Slack (${where})`, new Error(e), ref);

    // Store slack_ts as a single-winner claim (.is null) so a slow first fire can't clobber a ts a fallback
    // post already stored — avoids orphaned/duplicate cards.
    const claimTs = (ts: string, ch: string) => matchKey(admin.from("leads").update({ slack_ts: ts, slack_channel: ch })).is("slack_ts", null);

    if (isFirst) {
      // This fire owns the message — post it once.
      const r = await slackPost(channel, mkText(isCompleted));
      if (r.ok && r.ts) await claimTs(r.ts, r.channel ?? channel);
      else if (!r.ok) reportSlack(isCompleted ? "completed" : "started", r.error || "post failed");
    } else {
      // Existing row → EDIT its message in place (progress or completion) — never a second message.
      let ex = (await matchKey(admin.from("leads").select("slack_ts, slack_channel")).maybeSingle()).data as { slack_ts: string | null; slack_channel: string | null } | null;
      // The first fire may have claimed the row but not stored its Slack ts yet. Poll briefly (~3s) so we edit
      // its message instead of posting a duplicate (C34).
      for (let i = 0; i < 6 && ex && !ex.slack_ts; i++) {
        await sleep(500);
        ex = (await matchKey(admin.from("leads").select("slack_ts, slack_channel")).maybeSingle()).data as any;
      }
      if (ex?.slack_ts) {
        // Re-read the row's stage FRESH right before editing so a concurrent completed fire can't be regressed
        // back to "in progress". Completed is terminal — never downgrade the card.
        const fresh = (await matchKey(admin.from("leads").select("stage")).maybeSingle()).data as { stage: string | null } | null;
        const rowCompleted = isCompleted || fresh?.stage === "completed";
        const r = await slackUpdate(ex.slack_channel || channel, ex.slack_ts, mkText(rowCompleted));
        if (!r.ok) reportSlack("update", r.error || "update failed");
      } else if (isCompleted) {
        // No message to edit (the first post failed) — post the completed one now so completion isn't silent.
        const r = await slackPost(channel, mkText(true));
        if (r.ok && r.ts) await claimTs(r.ts, r.channel ?? channel);
        else if (!r.ok) reportSlack("completed", r.error || "post failed");
      }
      // A non-completed progress fire with no ts yet: skip posting; the first fire will post and a later fire edits it.
    }

    // --- Meta CAPI ---
    const capiFields = {
      email: b.email,
      phone: b.phone,
      fbp: b.fbp,
      fbc: b.fbc,
      clientIp: b.client_ip,
      clientUserAgent: b.client_user_agent,
      eventSourceUrl: b.page_url,
    };

    // Lead: once, on the genuine first step (unchanged). Deduped against the browser pixel via event_id.
    const paid = isPaidClick(b) && !!b.event_id;
    const fireLead = isFirst && !isCompleted && paid; // one Lead per lead — not re-fired on every progress step
    if (fireLead) {
      const capi = await sendCapiEvent({ eventName: "Lead", eventId: b.event_id!, ...capiFields });
      if (!capi.ok) await reportError("Website audit → Meta CAPI (Lead)", new Error(capi.error || "capi failed"), ref);
    } else if (isPaidClick(b) && !b.event_id && isFirst) {
      // C36: a paid click with no event_id silently gets no CAPI (correct — firing without it would double-count
      // vs the browser pixel). Surface it so a landing-page wiring gap is visible instead of silent.
      console.warn("website lead: paid click without event_id — Lead CAPI skipped (landing-page contract gap)", ref);
    }

    // CompleteRegistration: fired ONLY when the landing page flags this payload (the qualifying moment —
    // €1M answer = yes — usually a mid-form "progress" fire, NOT completion). The flag already encodes the
    // full gate (real ad click + qualified + pixel enabled) and arrives on exactly one payload per lead,
    // whose event_id the browser pixel used for ITS CompleteRegistration — so we send that id VERBATIM and
    // Meta dedupes browser+server. A qualified lead who abandons mid-form still counts (intended).
    // At-most-once per lead: a single-winner DB claim (cr_fired_at IS NULL → set) makes a retried/duplicate
    // POST lose the claim and send nothing. If the send fails, the claim is released so a retry can re-fire
    // (same event_id — Meta would dedupe even a rare double-send).
    if (b.fire_complete_registration === true) {
      if (!b.event_id) {
        console.warn("website lead: fire_complete_registration without event_id — CR skipped (landing-page contract gap)", ref);
        await reportError("Website audit → Meta CAPI (CR)", new Error("fire_complete_registration=true arrived without event_id"), ref);
      } else {
        const claim = await matchKey(
          // audit_qualified: the flag certifies the lead qualified — record it now so an abandon-after-qualify
          // lead isn't left as unknown (the completed fire, if it ever comes, agrees).
          admin.from("leads").update({ cr_fired_at: new Date().toISOString(), cr_event_id: b.event_id, audit_qualified: true })
        )
          .is("cr_fired_at", null)
          .select("id");
        if (claim.error) {
          await reportError("Website audit → CR claim", claim.error, ref);
        } else if (Array.isArray(claim.data) && claim.data.length > 0) {
          const capi = await sendCapiEvent({ eventName: "CompleteRegistration", eventId: b.event_id, ...capiFields });
          if (!capi.ok) {
            // Release the claim (keep cr_event_id for audit) so a landing-page retry can attempt again.
            // The release itself can fail (supabase-js returns, never throws) — retry once, and if it STILL
            // fails, alert explicitly: the row would be stuck "fired" with no server CR sent and no retry path.
            let rel = await matchKey(admin.from("leads").update({ cr_fired_at: null })).eq("cr_event_id", b.event_id);
            if (rel.error) rel = await matchKey(admin.from("leads").update({ cr_fired_at: null })).eq("cr_event_id", b.event_id);
            if (rel.error) await reportError("Website audit → CR claim release failed (claim stuck as fired; clear cr_fired_at manually)", rel.error, ref);
            await reportError("Website audit → Meta CAPI (CompleteRegistration)", new Error(capi.error || "capi failed"), ref);
          }
        }
        // Claim not won → CR already fired for this lead (duplicate/retry POST) — send nothing.
      }
    }

    return NextResponse.json({ ok: true, stage: isCompleted ? "completed" : "started", contactId: ghlContactId, answers: effectiveAnswers.length }, { headers: cors });
  } catch (e: any) {
    console.error("website lead failed:", e?.message ?? e);
    await reportError("Website audit pipeline", e, ref);
    return NextResponse.json({ ok: false, error: "processing failed" }, { status: 500, headers: cors });
  }
}
