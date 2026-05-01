import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import SecurityClient from "./SecurityClient";

export const metadata = { title: "Security — DA Platform" };

export default async function SecurityPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/security");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name, created_at")
    .eq("id", session.user.id)
    .single<{ role: string; full_name: string | null; created_at: string }>();

  return (
    <SecurityClient
      userEmail={session.user.email ?? ""}
      userRole={profile?.role ?? "dealer_user"}
      memberSince={profile?.created_at ?? session.user.created_at}
    />
  );
}
