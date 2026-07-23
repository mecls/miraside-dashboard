/**
 * The bootstrap admin account — always admin, can never be demoted or removed (prevents lockout).
 * Other users get role "admin" or "user" via app_metadata, toggled on the Team page.
 * Admins can change settings + manage the team; users cannot. Override the email via ADMIN_EMAIL.
 */
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "miguel.v.rolo@gmail.com").toLowerCase();

export function isAdminEmail(email?: string | null): boolean {
  return !!email && email.toLowerCase() === ADMIN_EMAIL;
}

/** A user is admin if they're the bootstrap admin email OR carry role:"admin" in their app_metadata. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isAdminUser(u: { email?: string | null; app_metadata?: Record<string, any> | null } | null | undefined): boolean {
  if (!u) return false;
  return isAdminEmail(u.email) || u.app_metadata?.role === "admin";
}
