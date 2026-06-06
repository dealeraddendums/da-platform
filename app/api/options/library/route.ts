import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getDealerOptionLibrary } from "@/lib/options-engine";

/**
 * GET /api/options/library?dealer_id=XXX
 * Returns all active default options for a dealer from Supabase addendum_library.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = req.nextUrl.searchParams.get("dealer_id");
  if (!dealerId) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }

  
  // Scope check: dealer roles can only fetch their own library
  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // group_admin may only read dealers in their own group (super_admin bypasses).
  if (claims.role === "group_admin") {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", dealerId)
      .maybeSingle<{ group_id: string | null }>();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const options = await getDealerOptionLibrary(dealerId);
    return NextResponse.json({ data: options });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch library";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
