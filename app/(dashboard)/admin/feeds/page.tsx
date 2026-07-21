import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import FeedsClient from "./FeedsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feeds — DA Platform" };

export default async function FeedsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/admin/feeds");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  const role =
    profile?.role ??
    ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined);
  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div>
      <PageHeader
        title="Feed Exports"
        subtitle="Push vehicle + addendum CSVs to inventory feed companies via FTP/SFTP."
      />
      <FeedsClient />
    </div>
  );
}
