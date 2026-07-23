import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { getLeadFormDefinition } from "@/lib/meta-ads";

export const runtime = "nodejs";

/**
 * Read a form that already lives on the Page ("on Meta"), mapped into the builder's shape so it can be
 * shown read-only — Meta forms are immutable (writes are silently ignored), so this is view + copy only.
 * `questions` stay in Meta's raw shape: the builder's questionsToBuilder already parses exactly that.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const f = await getLeadFormDefinition(id);
    const card = f?.context_card ?? null;
    const content: string[] = Array.isArray(card?.content) ? card.content.map((c: any) => String(c ?? "")) : [];
    const isList = String(card?.style ?? "").toUpperCase().includes("LIST");
    const ty = f?.thank_you_page ?? null;

    return NextResponse.json({
      ok: true,
      form: {
        id: String(f?.id ?? id),
        name: String(f?.name ?? ""),
        questions: Array.isArray(f?.questions) ? f.questions : [],
        greeting: card
          ? {
              headline: String(card.title ?? ""),
              style: isList ? "list" : "paragraph",
              paragraph: isList ? "" : content[0] ?? "",
              bullets: isList ? content : [],
            }
          : null,
        thankYou: ty
          ? {
              headline: String(ty.title ?? ""),
              message: String(ty.body ?? ""),
              websiteUrl: String(ty.website_url ?? ""),
              buttonText: String(ty.button_text ?? ""),
            }
          : null,
        isAudit: false, // the audit switch is ours (lives on saved forms), not a Meta concept
      },
    });
  } catch (e: any) {
    const raw = e?.message ?? "Couldn't load that form.";
    return NextResponse.json({ ok: false, error: /^Meta API /.test(raw) ? raw : "Couldn't load that form." }, { status: 502 });
  }
}
