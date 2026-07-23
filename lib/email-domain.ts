/**
 * Company-website inference from a lead's email: a professional (non-free-provider) domain IS the
 * company's website for B2B purposes. Pure + dependency-free — used server-side (GHL pushes, the
 * PATCH contact edits) and in the leads loader for display.
 */
const FREE_PROVIDERS = new Set([
  // global
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.es", "hotmail.it",
  "outlook.com", "outlook.pt", "outlook.fr", "outlook.es", "live.com", "live.fr", "live.com.pt", "msn.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.es", "yahoo.com.br", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com",
  "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com", "tutanota.com", "tuta.io",
  // Portuguese ISPs / legacy webmail
  "sapo.pt", "netcabo.pt", "telepac.pt", "mail.telepac.pt", "clix.pt", "iol.pt", "portugalmail.pt", "oniduo.pt",
]);

/** The email's domain when it looks professional (not a free provider); null otherwise. */
export function companyDomainFromEmail(email: string | null | undefined): string | null {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return null;
  const domain = e.slice(at + 1);
  if (!domain.includes(".") || domain.length < 4) return null;
  if (FREE_PROVIDERS.has(domain)) return null;
  return domain;
}
