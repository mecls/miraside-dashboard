"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setErr(error.message);
      setLoading(false);
      return;
    }
    // Land where the user was headed; refresh so the server picks up the new session. Only accept a
    // same-origin path (starts with a single "/") so a crafted ?redirect can't bounce to another site (N-login).
    const raw = sp.get("redirect") || "/";
    const redirect = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
    router.replace(redirect);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-7 shadow-xs">
      <div className="text-lg font-semibold tracking-tight text-neutral-50">Miraside Dashboard</div>
      <p className="mt-1 text-sm text-neutral-500">Sign in to continue.</p>

      <label className="mt-6 block text-xs font-medium uppercase tracking-wider text-neutral-500">Email</label>
      <input
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1.5 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
      />

      <label className="mt-4 block text-xs font-medium uppercase tracking-wider text-neutral-500">Password</label>
      <input
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1.5 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
      />

      {err && (
        <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{err}</div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="mt-6 inline-flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-sm font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
