import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { streamInvoice } from "@/lib/invoice-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { groupId: string; invoiceId: string } };

// GET /api/billing/groups/[groupId]/invoices/[invoiceId]/pdf[?download=1]
// Mirrors /api/billing/groups/[groupId] auth (super_admin any; group_admin own group).
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!(claims.role === "super_admin" || (claims.role === "group_admin" && claims.group_id === params.groupId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const admin = createAdminSupabaseClient();
  const { data: group } = await admin
    .from("groups").select("billing_customer_id").eq("id", params.groupId)
    .maybeSingle<{ billing_customer_id: string | null }>();
  const download = req.nextUrl.searchParams.get("download") === "1";
  return streamInvoice(group?.billing_customer_id ?? null, params.invoiceId, download);
}
