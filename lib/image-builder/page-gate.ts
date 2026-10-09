import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { getJwtClaims } from "@/lib/auth";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { DEALER_BUILDER_ROLES } from "./access";

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

/**
 * Server-page gate for a DEALER's Image Builder (2026-10-09): the session's
 * effective dealer (own store / switched-into store / ghosted store) — the same
 * rule the API applies on every ?dealer=1 call (requireBuilderScope). Returns
 * the dealer's name for the header. Everyone else goes to their dashboard.
 */
export async function gateDealerImageBuilderPage(next: string): Promise<{ dealerName: string }> {
  const claims = await getJwtClaims();
  if (!claims) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!DEALER_BUILDER_ROLES.has(claims.role) || !claims.dealer_id) redirect("/dashboard");
  const authz = await authorizeDealerAction(claims, claims.dealer_id);
  if (!authz.ok) redirect("/dashboard");
  const { data } = await createAdminSupabaseClient().from("dealers").select("name").eq("dealer_id", claims.dealer_id).maybeSingle<{ name: string }>();
  return { dealerName: data?.name ?? "your dealership" };
}
