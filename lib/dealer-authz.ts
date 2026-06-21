import { NextResponse } from "next/server";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * Shared dealer-context authorization.
 *
 * The principle (docs/group-admin-dealer-parity.md): a `group_admin` with an
 * active dealer (switched into an in-group dealer) is authorized EXACTLY like a
 * `dealer_admin` for that dealer — every dealer-context action. Cross-group is
 * blocked; the group_admin never gains super_admin/platform powers.
 *
 * `getJwtClaims` already resolves `claims.dealer_id` to the effective dealer for
 * every role: the dealer's own (dealer_admin/dealer_user), the active dealer
 * (group_admin with active_dealer_id, verified in-group at selection time), or
 * the ghost dealer (super_admin). So a group_admin's `claims.dealer_id` is always
 * an in-group dealer — but routes that accept a *client-supplied* dealer id
 * (query param / path / body) must still verify it, which `authorizeDealerAction`
 * does centrally so no route can silently omit the group check.
 */

/** Roles that act in a single dealer's context (vs. group/platform scope). */
const DEALER_ROLES = new Set(["dealer_admin", "dealer_user", "dealer_restricted"]);

function forbidden(): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
}
function badRequest(): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error: "dealer_id required" }, { status: 400 }) };
}

/**
 * The effective dealer the caller is acting as (text `dealer_id`), or null.
 * For a group_admin this is the active dealer (null when not switched into one);
 * for a super_admin it's the ghost dealer (null when not ghosting).
 */
export function resolveEffectiveDealer(claims: JwtClaims): string | null {
  return claims.dealer_id ?? null;
}

export type DealerAuthz =
  | { ok: true; dealerId: string }
  | { ok: false; response: NextResponse };

/**
 * Authorize a dealer-scoped action against a specific dealer (text `dealer_id`):
 *   - super_admin                  → any dealer
 *   - dealer_admin / dealer_user   → only their own dealer (`claims.dealer_id`)
 *   - group_admin                  → only a dealer in their group (`claims.group_id`)
 *   - group_user                   → only an in-group dealer carrying one of the
 *                                    manager's scope tags (`claims.scope_tag_ids`)
 *
 * Returns `{ ok: true, dealerId }` or `{ ok: false, response }` (a 400/403 to
 * return directly). The group membership lookup runs only for group_admin.
 */
export async function authorizeDealerAction(
  claims: JwtClaims,
  dealerId: string | null | undefined,
): Promise<DealerAuthz> {
  if (!dealerId) return badRequest();

  if (claims.role === "super_admin") return { ok: true, dealerId };

  if (DEALER_ROLES.has(claims.role)) {
    return claims.dealer_id === dealerId ? { ok: true, dealerId } : forbidden();
  }

  if (claims.role === "group_admin") {
    if (!claims.group_id) return forbidden();
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", dealerId)
      .maybeSingle<{ group_id: string | null }>();
    if (!dealer || dealer.group_id !== claims.group_id) return forbidden();
    return { ok: true, dealerId };
  }

  // group_user (regional manager): in-group AND the dealer carries one of the
  // manager's scope tags. Same dealer-level parity as a group_admin, but only
  // over their tagged subset. Empty scope ⇒ no dealers.
  if (claims.role === "group_user") {
    if (!claims.group_id) return forbidden();
    if (!claims.scope_tag_ids || claims.scope_tag_ids.length === 0) return forbidden();
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, group_id")
      .eq("dealer_id", dealerId)
      .maybeSingle<{ id: string; group_id: string | null }>();
    if (!dealer || dealer.group_id !== claims.group_id) return forbidden();
    // dealer must carry one of the manager's scope tags (dealer_tags lookup).
    // dealer_tags isn't in the generated Supabase types yet (migration 108).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tagRow } = await (admin as any)
      .from("dealer_tags")
      .select("tag_id")
      .eq("dealer_id", dealer.id)
      .in("tag_id", claims.scope_tag_ids)
      .limit(1)
      .maybeSingle();
    if (!tagRow) return forbidden();
    return { ok: true, dealerId };
  }

  return forbidden();
}

/**
 * Resolve the target dealer for a request and authorize it in one call —
 * the generalization of `/api/templates`' `resolveDealerId`.
 *
 * Precedence:
 *   - dealer roles            → pinned to their own dealer (an explicit id is ignored;
 *                               a mismatching one is rejected by authorizeDealerAction)
 *   - group_admin (switched in) / super_admin (ghost) → their effective dealer
 *   - otherwise (super_admin w/o ghost, group_admin w/o active dealer) → the
 *     explicit id (query param / path / body), then authorized
 *
 * Pass the explicit id a route accepts (e.g. `?dealer_id=` or a `[id]` segment);
 * omit it for routes that act purely on the caller's own/active dealer.
 */
export async function resolveDealerForRequest(
  claims: JwtClaims,
  explicitDealerId?: string | null,
): Promise<DealerAuthz> {
  // Dealer roles are pinned to their own dealer.
  if (DEALER_ROLES.has(claims.role)) {
    return authorizeDealerAction(claims, claims.dealer_id);
  }
  // group_admin / group_user switched in, or super_admin ghosting: use the
  // effective dealer (authorizeDealerAction re-verifies group + tag scope).
  if ((claims.role === "group_admin" || claims.role === "group_user" || claims.role === "super_admin") && claims.dealer_id) {
    return authorizeDealerAction(claims, claims.dealer_id);
  }
  // No effective dealer: fall back to the explicit id (then authorize it).
  if (!explicitDealerId) return badRequest();
  return authorizeDealerAction(claims, explicitDealerId);
}
