import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupRow } from "@/lib/db";
import GroupProfileCard from "@/components/GroupProfileCard";
import GroupOptionsPanel from "@/components/GroupOptionsPanel";

type Props = { params: { id: string } };

export const metadata = { title: "Group Profile — DA Platform" };

export default async function GroupPage({ params }: Props) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, group_id")
    .eq("id", session.user.id)
    .single<{ role: string; group_id: string | null }>();

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  const isSuperAdmin = role === "super_admin";
  const isGroupAdmin = role === "group_admin";

  if (!isSuperAdmin && !isGroupAdmin) redirect("/dashboard");
  if (isGroupAdmin && profile?.group_id !== params.id) {
    redirect(`/groups/${profile?.group_id ?? ""}`);
  }

  const { data: groupData } = await admin.from("groups").select("*").eq("id", params.id).single();
  const group = groupData as GroupRow | null;
  if (!group) notFound();

  const canEdit = isSuperAdmin || isGroupAdmin;

  return (
    <div>
      {isSuperAdmin && (
        <nav className="mb-4">
          <Link href="/groups" className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
            ← All Groups
          </Link>
        </nav>
      )}
      <GroupProfileCard group={group} canEdit={canEdit} isSuperAdmin={isSuperAdmin} />
      {(isSuperAdmin || isGroupAdmin) && (
        <GroupOptionsPanel groupId={params.id} />
      )}
    </div>
  );
}
