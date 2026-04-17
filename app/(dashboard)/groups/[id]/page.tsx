import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { ProfileRow, GroupRow } from "@/lib/db";
import GroupProfileCard from "@/components/GroupProfileCard";

type Props = { params: { id: string } };

export const metadata = { title: "Group Profile — DA Platform" };

export default async function GroupPage({ params }: Props) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const { data: profileData } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = profileData as ProfileRow | null;
  const isSuperAdmin = profile?.role === "super_admin";
  const isGroupAdmin = profile?.role === "group_admin";

  // Only super_admin and group_admin may view groups
  if (!isSuperAdmin && !isGroupAdmin) {
    redirect("/dashboard");
  }

  // group_admin may only view their own group
  if (isGroupAdmin && profile?.group_id !== params.id) {
    redirect(`/groups/${profile?.group_id ?? ""}`);
  }

  const admin = createAdminSupabaseClient();
  const { data: groupData } = await admin
    .from("groups")
    .select("*")
    .eq("id", params.id)
    .single();

  const group = groupData as GroupRow | null;
  if (!group) notFound();

  // group_admin can edit their own group's contact info; super_admin can edit anything
  const canEdit = isSuperAdmin || isGroupAdmin;

  return (
    <div>
      {/* Breadcrumb */}
      {isSuperAdmin && (
        <nav className="mb-4">
          <Link href="/groups" className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
            ← All Groups
          </Link>
        </nav>
      )}

      <GroupProfileCard
        group={group}
        canEdit={canEdit}
        isSuperAdmin={isSuperAdmin}
      />
    </div>
  );
}
