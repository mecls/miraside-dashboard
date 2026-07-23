import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { isAdminEmail, isAdminUser } from "@/lib/admin";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "@/components/TeamManager";

export const dynamic = "force-dynamic";

export default async function Page() {
  const admin = createAdminClient();
  const supa = await createServerSupabase();
  const {
    data: { user: me },
  } = await supa.auth.getUser();

  // Roster (emails + roles + join dates) is admin-only. Non-admins never see the user list.
  if (!isAdminUser(me)) redirect("/");

  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const users = (data?.users ?? [])
    .map((u) => ({
      id: u.id,
      email: u.email ?? "(no email)",
      createdAt: u.created_at ?? null,
      isAdmin: isAdminUser({ email: u.email, app_metadata: u.app_metadata }),
      isOwner: isAdminEmail(u.email), // the bootstrap admin — can't be demoted/removed
    }))
    // admins first, then alphabetical
    .sort((a, b) => (a.isAdmin === b.isAdmin ? a.email.localeCompare(b.email) : a.isAdmin ? -1 : 1));

  return (
    <div className="mx-auto max-w-3xl px-6 pb-10">
      <PageHeader title="Team" />
      <div className="mt-8">
        <TeamManager users={users} currentUserId={me?.id ?? null} canManage={isAdminUser(me)} />
      </div>
    </div>
  );
}
