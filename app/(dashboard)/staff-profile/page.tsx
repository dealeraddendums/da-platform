import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import StaffProfileClient from "./StaffProfileClient";

export const metadata = { title: "My Profile — DA Platform" };

export default async function StaffProfilePage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/staff-profile");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name, created_at")
    .eq("id", session.user.id)
    .single<{ role: string; full_name: string | null; created_at: string }>();

  const role = profile?.role ?? "dealer_user";

  // Only super_admin and group_admin may access this page
  if (role !== "super_admin" && role !== "group_admin") {
    redirect("/profile");
  }

  const { data: staffProfile } = await admin
    .from("staff_profiles")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();

  return (
    <StaffProfileClient
      userId={session.user.id}
      userEmail={session.user.email ?? ""}
      userRole={role}
      memberSince={profile?.created_at ?? ""}
      initialProfile={staffProfile ?? null}
    />
  );
}
