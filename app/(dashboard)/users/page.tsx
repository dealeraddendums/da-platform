import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { resolveActiveDealer } from "@/lib/active-dealer";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import UsersPageClient from "./UsersPageClient";

export const metadata = { title: "Users — DA Platform" };

export default async function UsersPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/users");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null; active_dealer_id: string | null }>(admin, session, "role, dealer_id, group_id, active_dealer_id");

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  // Session-scoped active dealer (lib/active-dealer.ts) — same resolver the API
  // layer uses, re-authorized per request, so chrome and data always agree.
  const activeDealerTextId = (await resolveActiveDealer(admin, {
    userId: session.user.id,
    role,
    groupId: profile?.group_id ?? null,
  })).textId;

  // A switched-in group_admin OR group_user (regional manager) gets the
  // dealer-scoped staff view for that dealer (full dealer parity).
  const isGroupAdminInDealerContext = (role === "group_admin" || role === "group_user") && !!activeDealerTextId;
  const isGroupAdminInGroupContext  = role === "group_admin" && !activeDealerTextId;

  // Check for ghost mode
  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;
  const isGhostMode = !!ghostDealerId;

  // Access check: super_admin (incl. ghost), dealer_admin, group_admin (any
  // context), or a switched-in group_user (dealer-scoped staff view only).
  if (role !== "super_admin" && role !== "dealer_admin" && role !== "group_admin" && !isGroupAdminInDealerContext) {
    redirect("/dashboard");
  }

  // Resolve effective dealer_id for scoped views
  let effectiveDealerId: string | null = profile?.dealer_id ?? null;
  let ghostDealerName: string | null = null;
  if (isGhostMode) {
    effectiveDealerId = ghostDealerId;
    const { data: ghostDlr } = await admin
      .from("dealers")
      .select("name")
      .eq("dealer_id", ghostDealerId!)
      .maybeSingle<{ name: string }>();
    ghostDealerName = ghostDlr?.name ?? null;
  } else if (isGroupAdminInDealerContext && activeDealerTextId) {
    effectiveDealerId = activeDealerTextId;
  }

  return (
    <UsersPageClient
      viewerRole={role}
      viewerDealerId={effectiveDealerId}
      viewerGroupId={isGroupAdminInGroupContext ? (profile?.group_id ?? null) : null}
      isGroupAdminContext={isGroupAdminInDealerContext}
      isGhostMode={isGhostMode}
      ghostDealerName={ghostDealerName}
    />
  );
}
