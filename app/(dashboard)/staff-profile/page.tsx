import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import StaffProfileClient from "./StaffProfileClient";

export const metadata = { title: "My Profile — DA Platform" };

export default async function StaffProfilePage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/staff-profile");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; full_name: string | null; created_at: string }>(admin, session, "role, full_name, created_at");

  const role = profile?.role ?? "dealer_user";

  // Only super_admin, group_admin, and group_user (regional manager) — all
  // group/platform staff (no dealer-scoped /profile) — may access this page.
  if (role !== "super_admin" && role !== "group_admin" && role !== "group_user") {
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
      // profiles.full_name is set at invite time. staff_profiles is a
      // separate, lazily-created row; when it doesn't exist or its
      // full_name is blank, pre-fill from the parent profile so the
      // user's name doesn't appear missing on first visit.
      profileFullName={profile?.full_name ?? ""}
    />
  );
}
