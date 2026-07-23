import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Supabase client bound to the request's auth cookies, for Server Components and
 * Route Handlers. Reads the session set by the login flow / refreshed by middleware.
 * Uses the publishable/anon key (NOT the service role) — this is the user-scoped client.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component (cookies are read-only there) — safe to ignore;
            // middleware is responsible for refreshing the session cookie.
          }
        },
      },
    }
  );
}
