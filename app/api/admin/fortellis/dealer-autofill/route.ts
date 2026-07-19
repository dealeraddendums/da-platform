import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveDealerAutofill } from "@/lib/fortellis-autofill";

/**
 * GET /api/admin/fortellis/dealer-autofill?dealer_id=<dealers.dealer_id>
 * Resolves the Add-Dealer autofill (name, dealer_id, best-known dealerCode,
 * cdk-fed flag, already-added flag). super_admin only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const dealerKey = req.nextUrl.searchParams.get("dealer_id")?.trim();
  if (!dealerKey) return NextResponse.json({ error: "dealer_id is required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const autofill = await resolveDealerAutofill(admin, dealerKey);
  if (!autofill) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  return NextResponse.json({ autofill });
}
