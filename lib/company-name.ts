/**
 * Company-name extraction from a lead's website. Deterministic heuristics, no AI:
 *   1. og:site_name — the site's own declared name (most reliable when present);
 *   2. JSON-LD Organization/LocalBusiness/WebSite name;
 *   3. <title>, cleaned — split on the usual "Name | slogan" separators, drop generic segments;
 *   4. the domain itself, capitalised ("miraside.co" → "Miraside").
 * Fetches are bounded (8s, ~500KB) so a dead site can never stall a sync cycle.
 */

const GENERIC_TITLE_SEGMENTS = new Set([
  "home",
  "homepage",
  "início",
  "inicio",
  "página inicial",
  "pagina inicial",
  "welcome",
  "bem-vindo",
  "bem vindo",
  "site oficial",
  "official site",
  "official website",
]);

/** "example.com/path" / "www.example.com" / full URLs → a fetchable https URL, or null if hopeless. */
export function normalizeWebsiteUrl(site: string | null | undefined): string | null {
  const raw = String(site ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const clean = (s: string): string =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Reasonable company-name shape: non-empty, not a sentence, not a URL, not server/builder junk
 *  ("Index of /" on a bare Apache listing, "Home Page …" titles — both shipped as real values once). */
const plausible = (s: string): boolean =>
  s.length >= 2 &&
  s.length <= 60 &&
  !/https?:\/\//i.test(s) &&
  s.split(" ").length <= 7 &&
  !/^(index of|home ?page|página|pagina|under construction|coming soon|em construção)\b/i.test(s);

function fromTitle(title: string): string | null {
  // "Miraside – AI para clínicas" / "Home | Acme" → pick the first non-generic segment.
  const segments = title
    .split(/\s*[|–—·•:-]\s+|\s+[|–—·•]\s*/)
    .map(clean)
    .filter(Boolean);
  for (const seg of segments) {
    if (GENERIC_TITLE_SEGMENTS.has(seg.toLowerCase())) continue;
    if (plausible(seg)) return seg;
  }
  return null;
}

function fromJsonLd(html: string): string | null {
  const scripts = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of scripts) {
    const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(body);
      const nodes: any[] = [];
      const push = (n: any) => {
        if (!n || typeof n !== "object") return;
        nodes.push(n);
        if (Array.isArray(n)) n.forEach(push);
        if (n["@graph"]) push(n["@graph"]);
      };
      push(parsed);
      for (const n of nodes.flat()) {
        const type = String(Array.isArray(n?.["@type"]) ? n["@type"][0] : n?.["@type"] ?? "").toLowerCase();
        if ((type.includes("organization") || type.includes("localbusiness") || type === "website") && typeof n.name === "string") {
          const name = clean(n.name);
          if (plausible(name)) return name;
        }
      }
    } catch {
      /* malformed JSON-LD — try the next block */
    }
  }
  return null;
}

/** Domain fallback: "clinicasorriso.pt" → "Clinicasorriso". Better than an empty cell, never great. */
function fromDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    const root = host.split(".")[0];
    if (!root || root.length < 2) return null;
    return root.charAt(0).toUpperCase() + root.slice(1);
  } catch {
    return null;
  }
}

export async function extractCompanyName(site: string | null | undefined): Promise<string | null> {
  const url = normalizeWebsiteUrl(site);
  if (!url) return null;
  let html = "";
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      redirect: "follow",
      headers: {
        // A real-browser UA: several site builders serve bots an empty shell.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return fromDomain(url);
    html = (await res.text()).slice(0, 500_000);
  } catch {
    return fromDomain(url);
  }

  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (og?.[1]) {
    const name = clean(og[1]);
    if (plausible(name)) return name;
  }

  const ld = fromJsonLd(html);
  if (ld) return ld;

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    const name = fromTitle(clean(title[1]));
    if (name) return name;
  }

  return fromDomain(url);
}
