import { Nav } from "@/components/Nav";
import { SyncControl } from "@/components/SyncControl";
import { LogoMark } from "@/components/Brand";
import { Toaster } from "@/components/Toaster";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryTenantId } from "@/lib/tenant";

// Read fresh on every request so the sidebar's "synced Nm ago" is accurate (never a build-time cache).
export const dynamic = "force-dynamic";

async function readLastSyncedAt(): Promise<string | null> {
  try {
    const tenantId = await getPrimaryTenantId();
    if (!tenantId) return null;
    const { data } = await createAdminClient()
      .from("connections")
      .select("last_synced_at")
      .eq("tenant_id", tenantId)
      .eq("provider", "facebook")
      .maybeSingle();
    return (data as { last_synced_at: string | null } | null)?.last_synced_at ?? null;
  } catch {
    return null;
  }
}

// Dashboard chrome: sidebar (brand + nav + refresh/freshness + sign-out). Wraps every authenticated page.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const lastSyncedAt = await readLastSyncedAt();
  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 md:flex-row">
      {/* safe-top keeps the brand bar out from under an iPhone's notch/dynamic island. */}
      <aside className="safe-top safe-x shrink-0 border-b border-neutral-800 bg-panel md:sticky md:top-0 md:flex md:h-screen md:w-60 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-neutral-800 px-5">
          <LogoMark className="h-7 w-7" />
          <span className="truncate text-sm font-medium text-neutral-50">Miraside dashboard</span>
        </div>
        <div className="px-3 pb-4 pt-3 md:flex-1">
          <Nav />
        </div>
        <div className="border-t border-neutral-800 px-3 py-2">
          <SyncControl lastSyncedAt={lastSyncedAt} />
        </div>
      </aside>
      <main className="safe-x safe-bottom min-w-0 flex-1">{children}</main>
      <Toaster />
    </div>
  );
}
