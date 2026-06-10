import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { streamInvoice } from "@/lib/invoice-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { invoiceId: string } };

// GET /api/billing/me/invoices/[invoiceId]/pdf[?download=1]
// Mirrors /api/billing/me's dealer resolution: dealer_admin/user → own dealer;
// group_admin switched-in → claims.dealer_id (group-verified at selection, and
// re-checked here); super_admin ghost → claims.dealer_id; else ?dealer_id=.
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let dealerTextId: string | null = null;
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    dealerTextId = claims.dealer_id;
  } else if ((claims.role === "super_admin" || claims.role === "group_admin") && claims.dealer_id) {
    dealerTextId = claims.dealer_id;
  } else {
    dealerTextId = req.nextUrl.searchParams.get("dealer_id");
  }
  if (!dealerTextId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("group_id, billing_customer_id, internal_id")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{ group_id: string | null; billing_customer_id: string | null; internal_id: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // group_admin may only reach a dealer in their own group (defensive re-check).
  if (claims.role === "group_admin" && dealer.group_id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const download = req.nextUrl.searchParams.get("download") === "1";
  return streamInvoice(dealer.billing_customer_id ?? dealer.internal_id, params.invoiceId, download);
}
