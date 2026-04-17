import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { ProfileRow } from "@/lib/db";
import GroupList from "@/components/GroupList";

export const metadata = { title: "Groups — DA Platform" };

export default async function GroupsPage() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = data as ProfileRow | null;

  // group_admin: redirect to their own group
  if (profile?.role === "group_admin") {
    if (profile.group_id) {
      redirect(`/groups/${profile.group_id}`);
    }
    return (
      <div>
        <h1 className="text-xl font-semibold mb-2" style={{ color: "var(--text-inverse)" }}>
          Group
        </h1>
        <div className="card p-6">
          <p style={{ color: "var(--text-secondary)" }}>
            No group has been assigned to your account. Contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  // Non-admin roles have no group access
  if (profile?.role !== "super_admin") {
    redirect("/dashboard");
  }

  // super_admin: full group list
  return <GroupList />;
}
