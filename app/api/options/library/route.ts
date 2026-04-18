import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDealerOptionLibrary } from "@/lib/options-engine";

/**
 * GET /api/options/library?dealer_id=XXX
 * Returns all active default options for a dealer from addendum_defaults.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = req.nextUrl.searchParams.get("dealer_id");
  if (!dealerId) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }

  // TODO: verify this should use inventory_dealer_id (claims.dealer_id is Supabase; dealerId param matches Aurora DEALER_ID)
  // Scope check: dealer roles can only fetch their own library
  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const options = await getDealerOptionLibrary(dealerId);
    return NextResponse.json({ data: options });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch library";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
