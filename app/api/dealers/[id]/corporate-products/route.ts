import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getGroupOptionsForDealer } from "@/lib/options-engine";
import { authorizeDealerAction } from "@/lib/dealer-authz";

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

  // Scope check: dealer roles → own; group_admin → a dealer in their group;
  // super_admin → any.
  const authz = await authorizeDealerAction(claims, params.id);
  if (!authz.ok) return authz.response;

  const products = await getGroupOptionsForDealer(params.id);
  return NextResponse.json({ data: products });
}
