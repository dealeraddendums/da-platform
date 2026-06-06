import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupDisclaimers } from "@/lib/options-engine";
import { resolveDealerForRequest } from "@/lib/dealer-authz";

/**
 * GET /api/disclaimers?document_type=addendum|infosheet|all&dealer_id=xxx
 *
 * Returns the effective list of group disclaimers for the requesting dealer,
 * filtered to their state + document_type. Used by the Builder canvas to
 * preview Disclaimer widget content. Dealers/users get their own; a switched-in
 * group_admin gets their active dealer; super_admin supplies ?dealer_id=xxx.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
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
