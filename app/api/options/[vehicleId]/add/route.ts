import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";

type Params = { params: { vehicleId: string } };

/**
 * POST /api/options/[vehicleId]/add
 * Adds a single option to a vehicle.
 * Body: { option_name, option_price?, sort_order? }
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vehicleId = parseInt(params.vehicleId, 10);
  if (isNaN(vehicleId)) {
    return NextResponse.json({ error: "Invalid vehicleId" }, { status: 400 });
  }

  const body = await req.json() as { option_name?: string; option_price?: string; sort_order?: number };
  if (!body.option_name?.trim()) {
    return NextResponse.json({ error: "option_name required" }, { status: 400 });
  }

  const pool = getPool();
  const [vrows] = await pool.execute<VehicleRowPacket[]>(
    "SELECT DEALER_ID FROM dealer_inventory WHERE id = ? LIMIT 1",
    [vehicleId]
  );
  if (!vrows.length) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }
  const dealerId = vrows[0].DEALER_ID; // TODO: verify this should use inventory_dealer_id when comparing against claims.dealer_id

  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  // Get current max sort_order
  const { data: maxRow } = await admin
    .from("vehicle_options")
    .select("sort_order")
    .eq("vehicle_id", vehicleId)
    .eq("dealer_id", dealerId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .single();

  const sortOrder = body.sort_order ?? ((maxRow?.sort_order ?? -1) + 1);

  const { data, error: err } = await admin
    .from("vehicle_options")
    .insert({
      vehicle_id: vehicleId,
      dealer_id: dealerId,
      option_name: body.option_name.trim(),
      option_price: body.option_price?.trim() ?? "NC",
      sort_order: sortOrder,
      source: "manual",
    })
    .select("*")
    .single();

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ data });
}
