import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import GroupList from "@/components/GroupList";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Groups — DA Platform" };

export default async function GroupsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; group_id: string | null }>(admin, session, "role, group_id");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role === "super_admin") {
    return <GroupList />;
  }

  if (role === "group_admin") {
    if (profile?.group_id) redirect(`/groups/${profile.group_id}`);
    return (
      <div>
        <PageHeader title="Group" />
        <div className="card p-6">
          <p style={{ color: "var(--text-secondary)" }}>
            No group has been assigned to your account. Contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  redirect("/dashboard");
}
