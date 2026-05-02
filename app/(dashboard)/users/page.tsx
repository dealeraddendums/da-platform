import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import UsersPageClient from "./UsersPageClient";

export const metadata = { title: "Users — DA Platform" };

export default async function UsersPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/users");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, group_id, active_dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null; group_id: string | null; active_dealer_id: string | null }>();

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  const isGroupAdminInDealerContext = role === "group_admin" && !!profile?.active_dealer_id;

  // Check for ghost mode
  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  // Only super_admin, dealer_admin, and group_admin in dealer context may access
  if (role !== "super_admin" && role !== "dealer_admin" && !isGroupAdminInDealerContext) {
    redirect("/dashboard");
  }

  // For group_admin in dealer context: resolve the text dealer_id for the active dealer
  let effectiveDealerId = profile?.dealer_id ?? ghostDealerId ?? null;
  if (isGroupAdminInDealerContext && profile?.active_dealer_id) {
    const { data: activeDlr } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", profile.active_dealer_id)
      .maybeSingle<{ dealer_id: string }>();
    if (activeDlr) effectiveDealerId = activeDlr.dealer_id;
  } else if (ghostDealerId) {
    effectiveDealerId = ghostDealerId;
  }

  return (
    <UsersPageClient
      viewerRole={role}
      viewerDealerId={effectiveDealerId}
      isGroupAdminContext={isGroupAdminInDealerContext}
    />
  );
}
