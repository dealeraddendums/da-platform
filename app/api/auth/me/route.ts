import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/auth/me
 * Who-am-I for headless clients (mobile app, IOS-APP-SPEC §4.2/§9). The JWT
 * carries no role claims (no custom_access_token_hook) and role resolution
 * has server-side subtleties (profiles email-fallback for uid-mismatch,
 * active-dealer resolution, ghost overlay) that live in getJwtClaims() —
 * clients must read the resolved context from here, never derive it.
 *
 * Works with cookie or Authorization: Bearer auth, and reflects the
 * X-DA-Ghost-Token header when present (dealer = the ghosted dealer).
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Display name from the caller's profile (email-fallback like getJwtClaims).
  let fullName: string | null = null;
  {
    const { data: p } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", claims.sub)
      .maybeSingle<{ full_name: string | null }>();
    fullName = p?.full_name ?? null;
    if (fullName === null && claims.email) {
      const { data: pe } = await admin
        .from("profiles")
        .select("full_name")
        .eq("email", claims.email)
        .maybeSingle<{ full_name: string | null }>();
      fullName = pe?.full_name ?? null;
    }
  }

  // The effective dealer context (own dealer, active dealer, or ghost dealer —
  // getJwtClaims already resolved claims.dealer_id to the right one).
  let dealer: { id: string; dealer_id: string; name: string } | null = null;
  if (claims.dealer_id) {
    const { data: d } = await admin
      .from("dealers")
      .select("id, dealer_id, name")
      .eq("dealer_id", claims.dealer_id)
      .maybeSingle<{ id: string; dealer_id: string; name: string }>();
    dealer = d ?? null;
  }

  let groupName: string | null = null;
  if (claims.group_id) {
    const { data: g } = await admin
      .from("groups")
      .select("name")
      .eq("id", claims.group_id)
      .maybeSingle<{ name: string }>();
    groupName = g?.name ?? null;
  }

  return NextResponse.json({
    user: { id: claims.sub, email: claims.email, full_name: fullName },
    role: claims.role,
    dealer,                                  // effective dealer context (null when none)
    group_id: claims.group_id,
    group_name: groupName,
    active_dealer_id: claims.active_dealer_id,
    is_ghost: claims.is_ghost,
    scope_tag_ids: claims.scope_tag_ids,
  });
}
