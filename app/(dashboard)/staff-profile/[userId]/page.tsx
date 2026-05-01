import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import StaffProfileClient from "../StaffProfileClient";

export const metadata = { title: "Staff Profile — DA Platform" };

export default async function StaffProfileByIdPage({
  params,
}: {
  params: { userId: string };
}) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();

  // Only super_admin may view/edit other staff profiles
  const { data: viewer } = await admin
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single<{ role: string }>();

  if (viewer?.role !== "super_admin") redirect("/dashboard");

  // Own profile — redirect to canonical URL
  if (params.userId === session.user.id) redirect("/staff-profile");

  const { data: targetProfile } = await admin
    .from("profiles")
    .select("role, full_name, email, created_at")
    .eq("id", params.userId)
    .single<{ role: string; full_name: string | null; email: string; created_at: string }>();

  if (!targetProfile || !["super_admin", "group_admin"].includes(targetProfile.role)) {
    redirect("/users");
  }

  const { data: staffProfile } = await admin
    .from("staff_profiles")
    .select("*")
    .eq("user_id", params.userId)
    .maybeSingle();

  return (
    <StaffProfileClient
      userId={params.userId}
      userEmail={targetProfile.email}
      userRole={targetProfile.role}
      memberSince={targetProfile.created_at}
      initialProfile={staffProfile ?? null}
      viewerIsSuperAdmin
    />
  );
}
