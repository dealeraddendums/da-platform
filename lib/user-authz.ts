// Canonical target-user authorization, shared by every route that writes (or
// reads privileged data) against a specific profiles row. Extracted from
// app/api/users/[id]/route.ts (cae70d5) so the Store Tags routes can reuse it
// instead of hand-rolling a check.
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import type { JwtClaims } from "@/lib/auth";

export type TargetUser = { dealer_id: string | null; group_id: string | null; role: string; email: string };

/**
 * Authorize an action against a target user, by the SAME canonical rule the
 * rest of the platform uses (docs/group-admin-dealer-parity.md):
 *   - super_admin                → any user
 *   - dealer_admin               → users on their own dealer
 *   - group_admin                → users on an in-group dealer, OR a group-level
 *                                  user (no dealer_id) of their own group
 *   - group_user (regional mgr)  → users on an in-group dealer within tag scope
 */
export async function authorizeUserTarget(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  claims: JwtClaims,
  targetId: string,
): Promise<{ ok: true; target: TargetUser } | { ok: false; response: NextResponse }> {
  const { data: target } = await admin
    .from("profiles")
    .select("dealer_id, group_id, role, email")
    .eq("id", targetId)
    .maybeSingle<TargetUser>();
  if (!target) return { ok: false, response: NextResponse.json({ error: "User not found" }, { status: 404 }) };

  if (claims.role === "super_admin") return { ok: true, target };

  // Dealer-level target → canonical dealer authorization (own / in-group / tag).
  if (target.dealer_id) {
    const authz = await authorizeDealerAction(claims, target.dealer_id);
    if (!authz.ok) return { ok: false, response: authz.response };
    return { ok: true, target };
  }

  // Group-level target (no dealer_id): only a group_admin of the SAME group may
  // manage them (group_user has dealer-parity only, not group management).
  if (target.group_id && claims.role === "group_admin" && claims.group_id === target.group_id) {
    return { ok: true, target };
  }

  return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
}

/**
 * Store Tags editor authorization (GET store-scope / GET+PUT tags):
 * super_admin (any user), or group_admin against a group_user IN THEIR OWN
 * GROUP. Everyone else — including group_user themselves — is refused: tag
 * scope defines what a Regional Manager can see, so only their group's admin
 * or platform staff may change it. Tag CREATION stays on dealer/group profiles.
 */
export async function authorizeStoreTagsAccess(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  claims: JwtClaims,
  targetId: string,
): Promise<{ ok: true; target: TargetUser } | { ok: false; response: NextResponse }> {
  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const authz = await authorizeUserTarget(admin, claims, targetId);
  if (!authz.ok) return authz;
  // group_admin may only touch the tag scope of a group_user (the only role
  // tags apply to) — not other admins' inert user_tags rows.
  if (claims.role === "group_admin" && authz.target.role !== "group_user") {
    return { ok: false, response: NextResponse.json({ error: "Store tags can only be edited on Regional Manager (group_user) accounts" }, { status: 403 }) };
  }
  return authz;
}
