import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import BannersClient from "./BannersClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Platform Banners — DA Platform" };

export default async function BannersPage() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/admin/banners");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  const role =
    profile?.role ??
    ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined);
  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div>
      <PageHeader
        title="Platform Banners"
        subtitle="Show a message at the top of the app for all users within a scheduled window."
      />
      <BannersClient />
    </div>
  );
}
