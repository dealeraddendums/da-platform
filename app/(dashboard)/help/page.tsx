import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import HelpClient from "./HelpClient";
import { getJwPublicConfig } from "@/lib/jwplayer";

export const metadata = { title: "Help — DA Platform" };

/**
 * Resolves the dealer whose Help page this is, so provider-specific guides
 * (currently just DealerTrack) show for the right dealership. Same precedence
 * as Print Settings: a ghosting super_admin sees the dealer being viewed, a
 * group_admin/group_user sees the dealer they switched into, everyone else
 * sees their own.
 */
export default async function HelpPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null; active_dealer_id: string | null }>(admin, session, "role, dealer_id, group_id, active_dealer_id");

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  const isDealer = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";
  let dealerId = isDealer ? (profile?.dealer_id ?? null) : (ghostDealerId ?? null);

  if (!dealerId && (role === "group_admin" || role === "group_user") && profile?.active_dealer_id) {
    const { data: d } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", profile.active_dealer_id)
      .maybeSingle<{ dealer_id: string }>();
    dealerId = d?.dealer_id ?? null;
  }

  let inventoryProvider: string | null = null;
  if (dealerId) {
    const { data } = await admin
      .from("dealers")
      .select("inventory_provider")
      .eq("dealer_id", dealerId)
      .maybeSingle<{ inventory_provider: string | null }>();
    inventoryProvider = data?.inventory_provider ?? null;
  }

  // Site + player id only — the JW API secret never leaves the server.
  return <HelpClient inventoryProvider={inventoryProvider} jw={getJwPublicConfig()} />;
}
