"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "./ui";

type User = { id: string; email: string; createdAt: string | null; isAdmin: boolean; isOwner: boolean };

// Readable, strong password (no ambiguous chars), generated in the browser.
function genPassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = new Uint32Array(14);
  crypto.getRandomValues(arr);
  let p = "";
  for (const x of arr) p += chars[x % chars.length];
  return p + "!7";
}

export function TeamManager({ users, currentUserId, canManage }: { users: User[]; currentUserId: string | null; canManage: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<{ email: string; password: string } | null>(null);

  // Generate after mount (avoids a server/client hydration mismatch).
  useEffect(() => {
    setPassword(genPassword());
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    setAdded(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j.error ?? "Could not add this user.");
      } else {
        setAdded({ email: email.trim().toLowerCase(), password });
        setEmail("");
        setPassword(genPassword());
        router.refresh();
      }
    } catch {
      setErr("Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function setRole(id: string, role: "admin" | "user") {
    setBusyId(id);
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, role }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) alert(j.error ?? "Could not change the role.");
      else router.refresh();
    } catch {
      alert("Network error — the role wasn't changed. Try again."); // was an unhandled rejection with no feedback (C52)
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string, em: string) {
    if (!confirm(`Remove ${em}? They lose access immediately.`)) return;
    setBusyId(id);
    try {
      const res = await fetch("/api/users?id=" + encodeURIComponent(id), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) alert(j.error ?? "Could not remove this user.");
      else router.refresh();
    } catch {
      alert("Network error — the user wasn't removed. Try again."); // was an unhandled rejection with no feedback (C52)
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Add user (admins only) */}
      {canManage && (
        <form onSubmit={add} className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-xs">
          <h3 className="mono-label">Add a user</h3>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-[200px]">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-neutral-500">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="mt-1 h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
              />
            </label>
            <label className="flex-1 min-w-[200px]">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-neutral-500">Password</span>
              <div className="mt-1 flex gap-1.5">
                <input
                  type="text"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-[34px] w-full rounded-md border border-neutral-700 bg-surface-200 px-3 text-sm tabular-nums text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500 focus:ring-2 focus:ring-accent/20"
                />
                <button
                  type="button"
                  onClick={() => setPassword(genPassword())}
                  title="Generate a new password"
                  className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none"
                >
                  ↻
                </button>
              </div>
            </label>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent px-2.5 text-xs font-medium text-[#161616] transition-colors hover:bg-accent-600 focus-visible:outline-none disabled:opacity-50"
            >
              {saving ? "Adding…" : "Add"}
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-600">New users start with “user” access. Promote them to admin below.</p>
          {err && <div className="mt-3 text-xs text-rose-400">{err}</div>}
          {added && (
            <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200/90">
              ✓ Added <span className="font-medium">{added.email}</span>. Share this login with them:
              <div className="mt-1 select-all font-mono text-emerald-100">
                {added.email} · {added.password}
              </div>
              <div className="mt-1 text-emerald-200/60">Copy it now — for security it won't be shown again.</div>
            </div>
          )}
        </form>
      )}

      {/* Users */}
      <div>
        <h3 className="mono-label">Users ({users.length})</h3>
        <div className="mt-3 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xs">
          {users.map((u) => {
            const isMe = u.id === currentUserId;
            const busy = busyId === u.id;
            return (
              <div key={u.id} className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3 last:border-0 hover:bg-surface-200/50">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-neutral-100">{u.email}</span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        u.isAdmin ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-neutral-700 bg-neutral-500/10 text-neutral-400"
                      )}
                    >
                      {u.isAdmin ? "admin" : "user"}
                    </span>
                    {isMe && <span className="text-[10px] text-neutral-600">· you</span>}
                  </div>
                  {u.createdAt && <div className="mt-0.5 text-xs text-neutral-600">added {new Date(u.createdAt).toISOString().slice(0, 10)}</div>}
                </div>

                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Role toggle — the bootstrap admin (owner) is locked. */}
                    {u.isOwner ? (
                      <span className="text-[10px] text-neutral-600">owner</span>
                    ) : (
                      <button
                        onClick={() => setRole(u.id, u.isAdmin ? "user" : "admin")}
                        disabled={busy}
                        className="inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-700/30 px-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-700/50 focus-visible:outline-none disabled:opacity-50"
                      >
                        {u.isAdmin ? "Make user" : "Make admin"}
                      </button>
                    )}
                    {/* Remove — admins can't be removed (demote first); you can't remove yourself. */}
                    <button
                      onClick={() => remove(u.id, u.email)}
                      disabled={u.isAdmin || isMe || busy}
                      title={u.isAdmin ? "Admins can't be removed — make them a user first" : isMe ? "You can't remove yourself" : undefined}
                      className={cn(
                        "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none",
                        u.isAdmin || isMe
                          ? "cursor-not-allowed border-neutral-800 bg-transparent text-neutral-700"
                          : "border-neutral-700 bg-neutral-700/30 text-rose-400 hover:border-rose-500/50 hover:bg-rose-500/10 disabled:opacity-50"
                      )}
                    >
                      {u.isAdmin || isMe ? "—" : "Remove"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!canManage && <p className="mt-2 text-xs text-neutral-600">Only admins can add users or change roles.</p>}
      </div>
    </div>
  );
}
