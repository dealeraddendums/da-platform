import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { getJwtClaims } from "@/lib/auth";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { DEALER_BUILDER_ROLES, GROUP_BUILDER_ROLES } from "./access";

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
  const dealerTextId = await dealerImageBuilderDealer(claims);
  if (!dealerTextId) redirect("/dashboard");
  const { data } = await createAdminSupabaseClient().from("dealers").select("name").eq("dealer_id", dealerTextId).maybeSingle<{ name: string }>();
  return { dealerName: data?.name ?? "your dealership" };
}

/** The dealer whose Image Builder this session may use, or null — the ONE rule
 *  behind the dealer pages above, the API (?dealer=1) and the Builder's
 *  "+ Create a background" link. */
async function dealerImageBuilderDealer(claims: NonNullable<Awaited<ReturnType<typeof getJwtClaims>>>): Promise<string | null> {
  if (!DEALER_BUILDER_ROLES.has(claims.role) || !claims.dealer_id) return null;
  const authz = await authorizeDealerAction(claims, claims.dealer_id);
  return authz.ok ? claims.dealer_id : null;
}

/**
 * Where the Template Builder's "+ Create a background" link should go, or null
 * when this session can't use an Image Builder in that context (2026-10-09):
 *   • group mode (group Builder, no dealer) → that group's Image Builder, for
 *     super_admin or a group_admin / group_user of the same group;
 *   • dealer mode → /image-builder, only when the session's own dealer IS the
 *     dealer being edited and the dealer Image Builder rule allows it.
 */
export async function imageBuilderHrefFor(ctx: { groupId: string | null; dealerId: string | null }): Promise<string | null> {
  const claims = await getJwtClaims();
  if (!claims) return null;
  if (ctx.groupId && !ctx.dealerId) {
    const ok = claims.role === "super_admin" || (GROUP_BUILDER_ROLES.has(claims.role) && claims.group_id === ctx.groupId);
    return ok ? `/groups/${ctx.groupId}/image-builder` : null;
  }
  if (ctx.dealerId) {
    const dealer = await dealerImageBuilderDealer(claims);
    return dealer && dealer === ctx.dealerId ? "/image-builder" : null;
  }
  return null;
}
