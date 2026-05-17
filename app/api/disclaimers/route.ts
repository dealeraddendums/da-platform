import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupDisclaimers } from "@/lib/options-engine";

/**
 * GET /api/disclaimers?document_type=addendum|infosheet|all&dealer_id=xxx
 *
 * Returns the effective list of group disclaimers for the requesting dealer,
 * filtered to their state + document_type. Used by the Builder canvas to
 * preview Disclaimer widget content. Dealers/users get their own; group_admin
 * / super_admin must supply ?dealer_id=xxx.
 */
async function resolveDealerId(
  req: NextRequest,
  claims: JwtClaims
): Promise<{ dealerId: string } | { dealerError: NextResponse }> {
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (!claims.dealer_id) {
      return { dealerError: NextResponse.json({ error: "No dealer assigned" }, { status: 403 }) };
    }
    return { dealerId: claims.dealer_id };
  }
  if (claims.role === "super_admin" && claims.dealer_id) {
    return { dealerId: claims.dealer_id };
  }
  const paramId = req.nextUrl.searchParams.get("dealer_id");
  if (!paramId) {
    return { dealerError: NextResponse.json({ error: "dealer_id param required" }, { status: 400 }) };
  }
  if (claims.role === "group_admin") {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin.from("dealers").select("group_id").eq("dealer_id", paramId).single();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return { dealerError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  return { dealerId: paramId };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const resolved = await resolveDealerId(req, claims);
  if ("dealerError" in resolved) return resolved.dealerError;
  const { dealerId } = resolved;

  const docType = (req.nextUrl.searchParams.get("document_type") || "all").toLowerCase();
  if (!["addendum", "infosheet", "all"].includes(docType)) {
    return NextResponse.json({ error: "Invalid document_type" }, { status: 400 });
  }

  // Resolve dealer state for state-specific matching
  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("state")
    .or(`dealer_id.eq.${dealerId},inventory_dealer_id.eq.${dealerId}`)
    .maybeSingle<{ state: string | null }>();

  const disclaimers = await getGroupDisclaimers(dealerId, dealer?.state ?? null, docType);
  return NextResponse.json({ data: disclaimers });
}
