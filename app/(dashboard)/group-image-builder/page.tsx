import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";

export const dynamic = "force-dynamic";

// Sidebar entry for the Group Image Builder: a regional manager (group_user)
// can't open My Group, so this resolves their group and lands them on its
// builder. group_admin / super_admin reach it from My Group → Image Builder.
export default async function GroupImageBuilderEntry() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/group-image-builder");
  const profile = await resolveSessionProfile<{ role: string; group_id: string | null }>(
    createAdminSupabaseClient(), session, "role, group_id",
  );
  if ((profile?.role === "group_user" || profile?.role === "group_admin") && profile.group_id) {
    redirect(`/groups/${profile.group_id}/image-builder`);
  }
  redirect("/dashboard");
}
