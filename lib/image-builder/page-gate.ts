import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";

/** Server-page gate for the Image Builder: super_admin or a granted profile. */
export async function gateImageBuilderPage(next: string): Promise<void> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);
  const profile = await resolveSessionProfile<{ role: string; can_use_image_builder: boolean | null }>(
    createAdminSupabaseClient(), session, "role, can_use_image_builder",
  );
  if (profile?.role === "super_admin" || profile?.can_use_image_builder === true) return;
  redirect("/dashboard");
}
