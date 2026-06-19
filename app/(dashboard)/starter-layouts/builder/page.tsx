import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "SuperAdmin Builder — DA Platform" };

/**
 * /starter-layouts/builder[?id=] — the Builder in platform-starter mode.
 * super_admin only. No id → create a new starter; ?id= → edit an existing one.
 * No dealer/group context; the preview uses the Builder's sample data and a
 * placeholder logo (dealerLogoUrl=null).
 */
export default async function StarterBuilderRoute({ searchParams }: { searchParams?: { id?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/starter-layouts");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  if (profile?.role !== "super_admin") redirect("/dashboard");

  const id = searchParams?.id ?? undefined;

  return (
    <BuilderPage
      starterMode
      starterTemplateId={id}
      dealerLogoUrl={null}
      canAddCustomSize={false}
      canAdminUpload
    />
  );
}
