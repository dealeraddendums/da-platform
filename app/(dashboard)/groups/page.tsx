import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { readGhostContext } from "@/lib/ghost-containment";
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

  // Ghost containment: a super_admin in ghost mode is operating INSIDE one
  // account, so the platform-wide groups list (and its per-row Ghost / Login
  // into OTHER groups, and + New Group) must not be reachable from here. A
  // group ghost lands on the ghosted group's own page — that is what the
  // group_admin nav's "My Group" means in that session. A dealer ghost has no
  // group page at all.
  const ghost = role === "super_admin" ? readGhostContext() : null;
  if (ghost?.group_id) redirect(`/groups/${ghost.group_id}`);
  if (ghost?.dealer_text_id) redirect("/dashboard");

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
