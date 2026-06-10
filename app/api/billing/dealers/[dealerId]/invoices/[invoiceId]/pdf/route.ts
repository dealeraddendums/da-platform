import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { streamInvoice } from "@/lib/invoice-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { dealerId: string; invoiceId: string } };

// GET /api/billing/dealers/[dealerId]/invoices/[invoiceId]/pdf[?download=1]
// Mirrors /api/billing/dealers/[dealerId] auth (super_admin any; group_admin
// in-group; dealer_admin/user own). customerKey = own billing_customer_id ??
// internal_id (same as the invoice list this tab renders).
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("dealer_id, group_id, billing_customer_id, internal_id")
    .eq("id", params.dealerId)
    .maybeSingle<{ dealer_id: string; group_id: string | null; billing_customer_id: string | null; internal_id: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (claims.role === "super_admin") { /* any */ }
  else if (claims.role === "group_admin") {
    if (dealer.group_id !== claims.group_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } else if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (dealer.dealer_id !== claims.dealer_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const download = req.nextUrl.searchParams.get("download") === "1";
  return streamInvoice(dealer.billing_customer_id ?? dealer.internal_id, params.invoiceId, download);
}
