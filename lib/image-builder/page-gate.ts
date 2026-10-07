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

/**
 * Server-page gate for the GROUP Image Builder (migration 167): super_admin, or
 * a group_admin / group_user whose own group this is. Everyone else is sent to
 * their dashboard. The API enforces the same rule on every call.
 */
export async function gateGroupImageBuilderPage(groupId: string, next: string): Promise<void> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);
  const profile = await resolveSessionProfile<{ role: string; group_id: string | null }>(
    createAdminSupabaseClient(), session, "role, group_id",
  );
  if (profile?.role === "super_admin") return;
  if ((profile?.role === "group_admin" || profile?.role === "group_user") && profile.group_id === groupId) return;
  redirect("/dashboard");
}
