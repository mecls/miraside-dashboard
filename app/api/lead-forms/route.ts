import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";
import { normalizeQuestions, normalizeGreeting } from "@/lib/leadform";
import { createLeadForm } from "@/lib/meta-ads";
import { getUrlSettings } from "@/lib/settings";

export const runtime = "nodejs";

/** Sanitize the builder's greeting into the stored shape (normalized into a Meta context_card at launch). */
function cleanGreeting(g: any): { headline: string; style: "paragraph" | "list"; paragraph: string; bullets: string[]; buttonText: string } | null {
  if (!g || typeof g !== "object") return null;
  const headline = String(g.headline ?? "").trim();
  const paragraph = String(g.paragraph ?? "").trim();
  const bullets = Array.isArray(g.bullets) ? g.bullets.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 5) : [];
  if (!headline && !paragraph && !bullets.length) return null;
  return { headline, style: g.style === "list" ? "list" : "paragraph", paragraph, bullets, buttonText: String(g.buttonText ?? "").trim() };
}

/** Sanitize the builder's after-submit (thank-you) screen into the stored shape. */
function cleanThankYou(t: any): { headline: string; message: string; websiteUrl: string; buttonText: string } | null {
  if (!t || typeof t !== "object") return null;
  const headline = String(t.headline ?? "").trim();
  const message = String(t.message ?? "").trim();
  const websiteUrl = String(t.websiteUrl ?? "").trim();
  const buttonText = String(t.buttonText ?? "").trim();
  if (!headline && !message && !websiteUrl && !buttonText) return null;
  return { headline, message, websiteUrl, buttonText };
}

function metaThankYou(ty: ReturnType<typeof cleanThankYou>, fallbackUrl: string) {
  return { title: ty?.headline || "", body: ty?.message || "", websiteUrl: ty?.websiteUrl || fallbackUrl, buttonText: ty?.buttonText || "" };
}

/**
 * Lead-form library endpoint. A form bundles questions + greeting + after-submit (thank-you) screen;
 * privacy is auto-stamped. The Meta instant form is minted lazily on launch so leads pool across reuse.
 * Modes:
 *   - { once: true }     → mint a throwaway Meta form now, return its id; nothing saved to the library.
 *   - { id }             → update an existing saved form (clears the cached Meta form so edits take effect).
 *   - (neither)          → save a new form to the library.
 */
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const name = String(b.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "Name the form." }, { status: 400 });

  const tenantId = await getPrimaryTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "No tenant configured." }, { status: 400 });

  const questions = normalizeQuestions(b.questions);
  const greeting = cleanGreeting(b.greeting);
  const thankYou = cleanThankYou(b.thankYou);
  const isAudit = b.isAudit === true; // ROI-audit form switch: only these forms' leads forward to the audit intake
  const admin = createAdminClient();
  const { defaultWebsiteUrl, privacyUrl } = await getUrlSettings(admin, tenantId);

  // Mode: use once — mint a Meta form immediately, save nothing. The launcher references it as "meta:<id>".
  if (b.once === true) {
    try {
      const form = await createLeadForm({
        name,
        privacyPolicyUrl: privacyUrl,
        questions,
        contextCard: normalizeGreeting(greeting),
        thankYou: metaThankYou(thankYou, defaultWebsiteUrl),
      });
      return NextResponse.json({ ok: true, once: true, metaId: form.id });
    } catch (e: any) {
      const raw = e?.message ?? "Could not create the form.";
      return NextResponse.json({ ok: false, error: /^Meta API /.test(raw) ? raw : "Could not create the form." }, { status: 502 });
    }
  }

  // Mode: update an existing form. Clear the cached Meta form id so the edit is re-minted on next launch
  // (Meta instant forms are immutable once created, so an updated form becomes a fresh Meta form).
  if (b.id) {
    const { data, error } = await admin
      .from("lead_form_templates")
      .update({ name, questions, greeting, thank_you: thankYou, privacy_url: privacyUrl, meta_form_id: null, is_audit: isAudit })
      .eq("id", String(b.id))
      .eq("tenant_id", tenantId)
      .select("id, name")
      .maybeSingle();
    if (error || !data) return NextResponse.json({ ok: false, error: error?.message ?? "Could not update the form." }, { status: 500 });
    return NextResponse.json({ ok: true, form: { id: data.id, name: data.name } });
  }

  // Mode: create a new saved form.
  const { data, error } = await admin
    .from("lead_form_templates")
    .insert({ tenant_id: tenantId, name, questions, greeting, thank_you: thankYou, privacy_url: privacyUrl, is_audit: isAudit })
    .select("id, name")
    .maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false, error: error?.message ?? "Could not save the form." }, { status: 500 });
  return NextResponse.json({ ok: true, form: { id: data.id, name: data.name } });
}
