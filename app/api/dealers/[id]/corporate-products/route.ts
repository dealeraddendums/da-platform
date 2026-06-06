import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupOptionsForDealer } from "@/lib/options-engine";

/**
 * GET /api/dealers/[id]/corporate-products
 * Returns the locked corporate products this dealer inherits from its parent
 * group, filtered through getGroupOptionsForDealer (which handles the
 * assign_all_dealers vs per-dealer assignment logic). The `id` segment is
 * the dealer's text id (e.g. "ga_1777483033478"), matching what
 * dealers.dealer_id stores and what profiles.dealer_id references — the
 * same value the addendum-library endpoint scopes by.
 *
 * Used by:
 *   - OptionsLibrary's dealer Products page so corporate products surface
 *     read-only alongside the dealer's own products.
 *   - Future per-vehicle paths that want a dealer-wide view independent of a
 *     specific vehicle (the existing /api/options/[vehicleId] surfaces them
 *     too, but scoped to a single vehicle's context).
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Scope check: dealers can only read their own corporate products; a group_admin
  // can read only dealers in their own group; super_admin can read any.
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    const myDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
    if (!myDealerId || myDealerId !== params.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role === "group_admin") {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", params.id)
      .maybeSingle<{ group_id: string | null }>();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const products = await getGroupOptionsForDealer(params.id);
  return NextResponse.json({ data: products });
}
