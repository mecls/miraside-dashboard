const BASE = "https://graph.facebook.com";

function cfg() {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const account = process.env.META_AD_ACCOUNT_ID;
  const version = process.env.META_API_VERSION || "v23.0";
  if (!token || !account) {
    throw new Error("Missing META_SYSTEM_USER_TOKEN or META_AD_ACCOUNT_ID");
  }
  return { token, account, version };
}

export function adAccountId(): string {
  return cfg().account;
}

/** The Facebook Page ads are published as (creatives reference it via object_story_spec). */
export function pageId(): string {
  const p = process.env.META_PAGE_ID;
  if (!p) throw new Error("Missing META_PAGE_ID");
  return p;
}

let _igActor: string | null | undefined;
/** The Instagram account connected to the Page (for creatives that explicitly target IG placements). Cached. */
export async function instagramActorId(): Promise<string | null> {
  if (_igActor !== undefined) return _igActor;
  try {
    const pg = await metaGet<any>(pageId(), { fields: "instagram_business_account{id}" });
    const v: string | null = pg?.instagram_business_account?.id ?? null; // cache only a CONFIRMED result (null = genuinely no IG)
    _igActor = v;
    return v;
  } catch {
    // Transient failure — don't poison the cache for the whole warm lambda; retry on the next call (C26).
    return null;
  }
}

// Meta throttling error codes: 4 (app), 17 (user), 32 (page), 341 (temporary), 613 (custom/account), 80004 (ads management).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80004]);
// Transient Meta-side errors (brief outages) — safe to retry: 1 (unknown), 2 (service temporarily unavailable).
const TRANSIENT_CODES = new Set([1, 2]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const metaErrorCode = (e: unknown): number | null => {
  const code = (e instanceof Error ? e.message : String(e)).match(/^Meta API (\d+):/)?.[1];
  return code != null ? Number(code) : null;
};

/** True for Meta rate-limit errors thrown by the request helpers below. */
function isRateLimitError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  const code = metaErrorCode(e);
  return (code != null && RATE_LIMIT_CODES.has(code)) || /rate limit|too many calls|request limit reached|reduce the amount/i.test(m);
}

/** True for transient Meta-side errors (code 1/2 or a "temporarily unavailable / unexpected, retry" message). */
export function isTransientError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  const code = metaErrorCode(e);
  return (code != null && TRANSIENT_CODES.has(code)) || /temporarily unavailable|unexpected error|please (try|retry)/i.test(m);
}

/**
 * Parse a Graph API response body. During an outage Meta's edge often returns a 5xx/429 with an HTML
 * body; a bare res.json() would throw a SyntaxError that the retry classifier can't see. Tag those as a
 * transient (code 2) / rate (429) error so withRetry actually backs off instead of surfacing a cryptic
 * parse error (N-metaresok).
 */
async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    if (res.status === 429) throw new Error(`Meta API 17: rate limit reached (HTTP 429)`);
    if (res.status >= 500) throw new Error(`Meta API 2: service temporarily unavailable (HTTP ${res.status})`);
    throw new Error(`Meta API 0: unexpected non-JSON response (HTTP ${res.status})`);
  }
}

/**
 * Run a Meta request, auto-retrying with exponential backoff when Meta throttles OR (for idempotent reads)
 * is transiently unavailable. Non-idempotent create POSTs pass rateOnly=true: a rate-limit is rejected
 * BEFORE creation (safe to retry), but a transient code-1/2 could mean the object WAS created — retrying it
 * would duplicate the campaign/ad set/ad, so those propagate instead (N-meta-2). Other errors propagate too.
 */
async function withRetry<T>(fn: () => Promise<T>, opts: { tries?: number; rateOnly?: boolean } = {}): Promise<T> {
  const tries = opts.tries ?? 4;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const rate = isRateLimitError(e);
      const retryable = rate || (!opts.rateOnly && isTransientError(e));
      if (!retryable || i === tries - 1) throw e;
      // Account-level throttles (code 17) clear slowly — back off much harder than a brief transient blip.
      await sleep((rate ? 4000 : 1500) * 2 ** i); // rate: 4→8→16s · transient: 1.5→3→6s
    }
  }
  throw last;
}

/**
 * Full-detail message for a Graph error payload. Meta's bare `message` is often useless — code 100 is just
 * "Invalid parameter"; the actual reason lives in error_user_msg / error_user_title, and the offending field
 * in error_data.blame_field_specs. Keep all of it so a failed launch says WHY.
 * The `Meta API <code>: ` prefix is load-bearing (parsed by the code matcher above) — don't change its shape.
 */
function metaErrorMessage(err: any): string {
  const bits: string[] = [String(err?.message ?? "unknown error")];
  if (err?.error_user_title) bits.push(String(err.error_user_title));
  if (err?.error_user_msg) bits.push(String(err.error_user_msg));
  let data = err?.error_data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* not JSON — ignore */ }
  }
  const blame = data?.blame_field_specs ?? data?.blame_field;
  if (blame) bits.push(`field: ${JSON.stringify(blame)}`);
  if (err?.error_subcode) bits.push(`subcode ${err.error_subcode}`);
  return `Meta API ${err?.code ?? 0}: ${Array.from(new Set(bits.filter(Boolean))).join(" — ")}`;
}

/**
 * Low-level authenticated Graph fetch with the same retry/backoff + safe JSON parsing as the helpers above.
 * For page-token endpoints (lead forms / lead reads) that can't use metaGet/metaPost but still need code-17
 * backoff. Pass rateOnly for non-idempotent POSTs (form creation) so a transient error can't duplicate.
 */
export async function graphFetch(url: string, init?: RequestInit, opts: { rateOnly?: boolean } = {}): Promise<any> {
  return withRetry(async () => {
    const res = await fetch(url, init);
    const json: any = await readJson(res);
    if (json.error) throw new Error(metaErrorMessage(json.error));
    return json;
  }, { rateOnly: opts.rateOnly });
}

/** Single GET against the Graph API. Throws on Meta error payloads. */
export async function metaGet<T = any>(
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const { token, version } = cfg();
  const url = new URL(`${BASE}/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return withRetry(async () => {
    const res = await fetch(url.toString());
    const json: any = await readJson(res);
    if (json.error) {
      throw new Error(metaErrorMessage(json.error));
    }
    return json as T;
  });
}

/** Fetch every page of an edge, following paging.next. */
export async function metaGetAll<T = any>(
  path: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  const { token, version } = cfg();
  const first = new URL(`${BASE}/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) first.searchParams.set(k, v);
  first.searchParams.set("access_token", token);

  let next: string | null = first.toString();
  const out: T[] = [];
  while (next) {
    const page: any = await withRetry(async () => {
      const res = await fetch(next!);
      const json: any = await readJson(res);
      if (json.error) {
        throw new Error(metaErrorMessage(json.error));
      }
      return json;
    });
    if (Array.isArray(page.data)) out.push(...page.data);
    next = page.paging?.next ?? null;
  }
  return out;
}

/**
 * POST (create or update) against the Graph API. Object/array-valued params are
 * JSON-encoded — Meta expects stringified JSON for fields like `targeting`,
 * `object_story_spec`, and `special_ad_categories`. Throws on Meta error payloads,
 * surfacing the user-facing message when present.
 */
export async function metaPost<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
  const { token, version } = cfg();
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  body.set("access_token", token);
  // rateOnly: a POST may create an object — only retry when Meta rejected it up-front (rate limit), never on
  // an ambiguous transient error that might have succeeded server-side (would duplicate the object).
  return withRetry(async () => {
    const res = await fetch(`${BASE}/${version}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json: any = await readJson(res);
    if (json.error) {
      throw new Error(metaErrorMessage(json.error));
    }
    return json as T;
  }, { rateOnly: true });
}

/** Upload a video (raw bytes) → returns the video_id. Processing continues async; multipart upload. */
export async function uploadAdVideo(bytes: Uint8Array, name = "video.mp4"): Promise<{ id: string }> {
  // Small videos: single multipart. Larger ones: Meta's resumable chunked protocol (avoids request-size limits).
  if (bytes.byteLength > 8 * 1024 * 1024) return uploadAdVideoResumable(bytes, name);
  const { token, version, account } = cfg();
  return withRetry(async () => {
    const form = new FormData();
    form.set("access_token", token);
    form.set("name", name);
    form.set("source", new Blob([bytes as any]), name);
    const res = await fetch(`${BASE}/${version}/${account}/advideos`, { method: "POST", body: form });
    const json: any = await readJson(res);
    if (json.error) throw new Error(metaErrorMessage(json.error));
    return json;
  });
}

/** Post one phase of a resumable /advideos upload as multipart form-data. */
async function advideosPhase(fields: Record<string, string>, chunk?: { bytes: Uint8Array; name: string }): Promise<any> {
  const { token, version, account } = cfg();
  return withRetry(async () => {
    const form = new FormData();
    form.set("access_token", token);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    if (chunk) form.set("video_file_chunk", new Blob([chunk.bytes as any]), chunk.name);
    const res = await fetch(`${BASE}/${version}/${account}/advideos`, { method: "POST", body: form });
    const json: any = await readJson(res);
    if (json.error) throw new Error(metaErrorMessage(json.error));
    return json;
  });
}

/**
 * Upload a (large) video to Meta with the resumable chunked protocol: start → transfer (following
 * Meta's offsets) → finish. Returns the video_id. Handles arbitrarily large files within memory.
 */
export async function uploadAdVideoResumable(bytes: Uint8Array, name = "video.mp4"): Promise<{ id: string }> {
  const start = await advideosPhase({ upload_phase: "start", file_size: String(bytes.byteLength) });
  const sessionId = String(start.upload_session_id);
  const videoId = String(start.video_id);
  let startOffset = Number(start.start_offset);
  let endOffset = Number(start.end_offset);
  while (startOffset < endOffset) {
    const next = await advideosPhase(
      { upload_phase: "transfer", upload_session_id: sessionId, start_offset: String(startOffset) },
      { bytes: bytes.subarray(startOffset, endOffset), name }
    );
    startOffset = Number(next.start_offset);
    endOffset = Number(next.end_offset);
  }
  await advideosPhase({ upload_phase: "finish", upload_session_id: sessionId });
  return { id: videoId };
}

/** Hard-delete an object. For ads, prefer archiving (status=ARCHIVED) over delete. */
export async function metaDelete<T = any>(path: string): Promise<T> {
  const { token, version } = cfg();
  const url = new URL(`${BASE}/${version}/${path}`);
  url.searchParams.set("access_token", token);
  return withRetry(async () => {
    const res = await fetch(url.toString(), { method: "DELETE" });
    const json: any = await readJson(res);
    if (json.error) throw new Error(metaErrorMessage(json.error));
    return json as T;
  });
}
