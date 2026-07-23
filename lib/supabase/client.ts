"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for the browser (login form, sign-out). Uses the publishable/anon key. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
