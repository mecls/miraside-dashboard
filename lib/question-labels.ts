import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Short CRM-style labels for lead-form questions, used in the Slack notification (e.g. the question
 * "Quantos colaboradores tem a tua empresa?" → "Company size"). Generated once per question by a
 * cheap vision-free model and cached in question_labels so it stays consistent and costs ~nothing.
 * Best-effort: any failure returns null and the caller falls back to the full question text.
 */
const PROMPT =
  "You are naming a lead-form question as a short CRM field label. Given the question, reply with a SHORT English label of 1-2 words in Title Case (e.g. 'Budget', 'Industry', 'Company size', 'Urgency', 'Main problem', 'Timeline'). Reply with ONLY the label — no quotes, no punctuation, no explanation.";

function clean(raw: string): string {
  let s = (raw || "").trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.!?,;:]+$/g, "").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 3) s = words.slice(0, 3).join(" ");
  return s.slice(0, 40).trim();
}

async function generateLabel(question: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: `${PROMPT}\n\nQuestion: ${question}` }],
      }),
    });
    const j: any = await res.json();
    if (j?.error) return null;
    const text = Array.isArray(j?.content) ? j.content.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ") : "";
    return clean(text) || null;
  } catch {
    return null;
  }
}

/** Get a cached short label for a question, generating + caching it on first sight. null on failure. */
export async function ensureShortLabel(admin: SupabaseClient, tenantId: string, question: string): Promise<string | null> {
  const q = question.trim();
  if (!q) return null;
  const { data } = await admin
    .from("question_labels")
    .select("label")
    .eq("tenant_id", tenantId)
    .eq("question", q)
    .maybeSingle();
  if (data?.label) return data.label as string;

  const label = await generateLabel(q);
  if (!label) return null;
  // Ignore conflict (another concurrent lead may have inserted the same question first).
  await admin.from("question_labels").upsert({ tenant_id: tenantId, question: q, label }, { onConflict: "tenant_id,question" });
  return label;
}
