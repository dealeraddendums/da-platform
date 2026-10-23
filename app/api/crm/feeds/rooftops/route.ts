import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { groupRooftops } from "@/lib/crm/feeds/orders";
import { orderNumber } from "@/lib/crm/feeds/templates";
import { UUID } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/crm/feeds/rooftops?group_company_id= — a group's dealerships for Start feed order's
 * checkboxes, each with the open feed order it's already on (those can't be ticked).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const id = req.nextUrl.searchParams.get("group_company_id") ?? "";
  if (!UUID.test(id)) return NextResponse.json({ error: "group_company_id required" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const rooftops = await groupRooftops(admin, id);
  const { data: busy } = rooftops.length
    ? await admin.from("crm_feed_orders").select("dealer_company_id, parent_order_id").in("dealer_company_id", rooftops.map((r) => r.id)).not("parent_order_id", "is", null).not("status", "in", "(done,cancelled)")
    : { data: [] };
  const by = Object.fromEntries((busy ?? []).map((b: any) => [b.dealer_company_id, b.parent_order_id]));
  return NextResponse.json({ rooftops: rooftops.map((r) => ({ ...r, open_order_id: by[r.id] ?? null, open_order_number: by[r.id] ? orderNumber(by[r.id]) : null })) });
}
