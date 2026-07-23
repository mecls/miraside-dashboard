import { createHash } from "crypto";

/**
 * Meta Conversions API (server-side) — sends the website-form "Lead" / "CompleteRegistration" events
 * straight to the pixel, so conversion tracking survives iOS/ad-blockers. Deduplicated against the
 * browser pixel via a shared `eventId`. Best-effort: returns {ok:false,...} on any failure, never throws.
 */
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const normEmail = (e?: string | null) => (e ? e.trim().toLowerCase() : "");
const normPhone = (p?: string | null) => (p ? p.replace(/\D/g, "") : ""); // E.164 digits, no '+'

export interface CapiInput {
  eventName: "Lead" | "CompleteRegistration";
  eventId: string;
  eventTimeSec?: number;
  email?: string | null;
  phone?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  clientIp?: string | null;
  clientUserAgent?: string | null;
  eventSourceUrl?: string | null;
}

export async function sendCapiEvent(i: CapiInput): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const pixel = process.env.META_PIXEL_ID;
  if (!token || !pixel) return { ok: false, error: "CAPI not configured (META_PIXEL_ID / token)" };
  const version = process.env.META_API_VERSION || "v23.0";

  const user_data: Record<string, unknown> = {};
  const em = normEmail(i.email);
  if (em) user_data.em = [sha256(em)];
  const ph = normPhone(i.phone);
  if (ph) user_data.ph = [sha256(ph)];
  if (i.fbp) user_data.fbp = i.fbp;
  if (i.fbc) user_data.fbc = i.fbc;
  if (i.clientIp) user_data.client_ip_address = i.clientIp;
  if (i.clientUserAgent) user_data.client_user_agent = i.clientUserAgent;

  const body = {
    data: [
      {
        event_name: i.eventName,
        event_time: i.eventTimeSec ?? Math.floor(Date.now() / 1000),
        event_id: i.eventId, // dedupe with the browser pixel event of the same id
        action_source: "website",
        ...(i.eventSourceUrl ? { event_source_url: i.eventSourceUrl } : {}),
        user_data,
      },
    ],
  };

  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j: any = await res.json();
    if (j?.error) return { ok: false, error: `Meta CAPI ${j.error.code}: ${j.error.message}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
