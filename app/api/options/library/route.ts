import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDealerOptionLibrary } from "@/lib/options-engine";
import { authorizeDealerAction } from "@/lib/dealer-authz";

/**
 * GET /api/options/library?dealer_id=XXX
 * Returns all active default options for a dealer from Supabase addendum_library.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // dealer roles → own; group_admin → in-group; super_admin → any.
  const authz = await authorizeDealerAction(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!authz.ok) return authz.response;
  const dealerId = authz.dealerId;

  try {
    const options = await getDealerOptionLibrary(dealerId);
    return NextResponse.json({ data: options });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch library";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
