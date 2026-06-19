import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import StarterLayoutsClient from "@/components/StarterLayoutsClient";

export const metadata = { title: "SuperAdmin Builder — DA Platform" };

export default async function StarterLayoutsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/starter-layouts");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  if (profile?.role !== "super_admin") redirect("/dashboard");

  return (
    <div>
      <PageHeader
        title="SuperAdmin Builder"
        subtitle="Platform starter layouts every dealer can start a new document from."
      />
      <StarterLayoutsClient />
    </div>
  );
}
