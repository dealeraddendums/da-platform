import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { PageHeader } from "@/components/PageHeader";
import MigrationConsole from "@/components/MigrationConsole";

export const metadata = { title: "Migration — DA Platform" };

export default async function MigrationPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single<{ role: string }>();

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div className="p-6">
      <PageHeader
        title="Migration Readiness"
        subtitle="Assign, prepare, invite, and track self-serve dealer migrations."
      />
      <MigrationConsole />
    </div>
  );
}
