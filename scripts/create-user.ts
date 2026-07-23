/**
 * Create (or reset the password of) the dashboard login user.
 *
 * The password is read from the environment so it never lands in shell history files
 * or a transcript. Run:
 *
 *   EMAIL="you@example.com" PASSWORD='choose-a-strong-one' npm run create:user
 *
 * Uses the service-role key (admin API), creates the user already email-confirmed so
 * they can sign in immediately. Safe to re-run — it updates the password if the user
 * already exists.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  if (!email || !password) {
    console.error('Usage: EMAIL="you@example.com" PASSWORD="strong-password" npm run create:user');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Find an existing user with this email (admin.listUsers is paged; one page is plenty here).
  const { data: list, error: listErr } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

  if (existing) {
    const { error } = await sb.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
    if (error) throw error;
    console.log(`✓ Updated password for existing user: ${email}`);
  } else {
    const { error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    console.log(`✓ Created user: ${email}`);
  }
  console.log("You can now sign in at /login.");
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
