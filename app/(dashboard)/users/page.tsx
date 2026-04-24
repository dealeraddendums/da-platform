import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import UsersPageClient from "./UsersPageClient";

export const metadata = { title: "Users — DA Platform" };

export default async function UsersPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/users");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  // Only super_admin and dealer_admin may access this page
  if (role !== "super_admin" && role !== "dealer_admin") {
    redirect("/dashboard");
  }

  return (
    <UsersPageClient
      viewerRole={role}
      viewerDealerId={profile?.dealer_id ?? null}
    />
  );
}
