import { getSettingsEditor } from "@/lib/settings-editor";
import { createServerSupabase } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function Page() {
  const settings = await getSettingsEditor();
  const supa = await createServerSupabase();
  const {
    data: { user },
  } = await supa.auth.getUser();
  const canEdit = isAdminUser(user);

  return (
    <div className="mx-auto max-w-3xl px-6 pb-10">
      <PageHeader title="Settings" />
      {!canEdit && (
        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
          You have <span className="font-medium text-neutral-200">user</span> access — settings are read-only. Ask an admin to make changes.
        </div>
      )}
      <div className="mt-8">
        <SettingsForm settings={settings} canEdit={canEdit} />
      </div>
    </div>
  );
}
