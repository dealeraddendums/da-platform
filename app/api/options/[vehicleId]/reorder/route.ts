import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { vehicleId: string } };

/**
 * PATCH /api/options/[vehicleId]/reorder
 * Body: { order: string[] } — array of option UUIDs in new order
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const body = await req.json() as { order?: string[] };
  if (!body.order || !Array.isArray(body.order)) {
    return NextResponse.json({ error: "order array required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Verify all options belong to this vehicle + correct dealer scope
  const { data: rows } = await admin
    .from("vehicle_options")
    .select("id, dealer_id")
    .in("id", body.order);

  if (!rows || rows.length !== body.order.length) {
    return NextResponse.json({ error: "Some option IDs not found" }, { status: 400 });
  }

  const dealerId = rows[0].dealer_id;
  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Batch update sort_order
  await Promise.all(
    body.order.map((id, i) =>
      admin
        .from("vehicle_options")
        .update({ sort_order: i })
        .eq("id", id)
    )
  );

  return NextResponse.json({ success: true });
}
